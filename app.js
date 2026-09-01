(() => {
  const cfg = window.C100_CONFIG || {};
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- SysEx protocol (matches firmware/sysex.c) -----------------------
  const PREFIX = [0xF0, 0x7D, 0x43, 0x31, 0x30, 0x30];       // "C100"
  const CMD = {
    DISCOVER: 0x01, DISCOVER_REPLY: 0x02,
    PAL_UPLOAD: 0x10, PAL_ACK: 0x11, PAL_DOWNLOAD: 0x12, PAL_DATA: 0x13, PAL_COMMIT: 0x14,
    ENTER_BOOTLOADER: 0x20
  };
  const PALETTE_SIZE = 128;
  const SLOTS = 3;

  const msg = (cmd, ...payload) => [...PREFIX, cmd, ...payload, 0xF7];
  const startsWith = (d, p) => d.length >= p.length && p.every((v, i) => d[i] === v);
  const compress8to6 = v => (Math.max(0, Math.min(255, v | 0)) >> 2) & 0x3F;
  const expand6to8 = v => { v &= 0x3F; return ((v << 2) | (v >> 4)) & 0xFF; };

  // ---- state ----------------------------------------------------------
  let midi = null, devOut = null, devIn = null;
  let connected = false;
  let selectedSlot = 0;
  let selectedIndex = 0;
  let flashing = false;
  // Editor starts on the C100 built-in "Original" palette (6-bit triples).
  const DEFAULT_PAL = Array.isArray(window.C100_ORIGINAL_PAL) ? window.C100_ORIGINAL_PAL : [];
  const palette = Array.from({ length: PALETTE_SIZE }, (_, i) =>
    Array.isArray(DEFAULT_PAL[i]) ? DEFAULT_PAL[i].slice(0, 3) : [0, 0, 0]);   // 6-bit

  // Swatch display order: two 8-wide banks per row — low half (0..63) on the
  // left, high half (64..127) on the right, so row r shows r*8..r*8+7 then
  // 64+r*8..64+r*8+7. Matches the C100's twin-bank grid.
  const GRID_ORDER = (() => {
    const o = [];
    for (let row = 0; row < 8; row++) {
      for (let c = 0; c < 8; c++) o.push(row * 8 + c);
      for (let c = 0; c < 8; c++) o.push(64 + row * 8 + c);
    }
    return o;
  })();
  const pendingAcks = new Map();
  const pendingReads = new Map();
  let discoverToken = 1;

  // ---- MIDI ---------------------------------------------------------------
  async function setupMidi() {
    if (!("requestMIDIAccess" in navigator)) { setStatus("WebMIDI unavailable", "error"); return; }
    try {
      midi = await navigator.requestMIDIAccess({ sysex: true });
      midi.onstatechange = () => { if (!flashing) discover(); };
      discover();
    } catch (e) { console.error(e); setStatus("MIDI permission required", "error"); }
  }

  function bindInputs() {
    if (!midi) return;
    for (const inp of midi.inputs.values()) inp.onmidimessage = onMidi;
  }

  let discovering = false;
  let retryTimer = null;
  function scheduleRetry(ms = 2000) {
    if (retryTimer || connected || flashing) return;
    retryTimer = setTimeout(() => { retryTimer = null; discover(); }, ms);
  }
  async function discover() {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (!midi || flashing || discovering) return;
    discovering = true;
    try { await discoverInner(); } finally { discovering = false; }
    if (!connected) scheduleRetry();          // keep polling for the port
  }
  async function discoverInner() {
    bindInputs();
    devOut = devIn = null; connected = false;
    setControls(false);
    setStatus("Searching for C100…");
    const outs = [...midi.outputs.values()];
    console.log(`[c100] MIDI outputs: ${outs.map(o => `"${o.name}"`).join(", ") || "(none)"}`);
    console.log(`[c100] MIDI inputs:  ${[...midi.inputs.values()].map(i => `"${i.name}"`).join(", ") || "(none)"}`);

    let sendError = null;
    for (const out of outs) {
      const token = (discoverToken = (discoverToken % 0x7E) + 1);
      const got = new Promise(res => {
        pendingAcks.set("disc:" + token, res);
        setTimeout(() => { pendingAcks.delete("disc:" + token); res(null); }, 400);
      });
      try {
        out.send(msg(CMD.DISCOVER, token));
        console.log(`[c100] -> discover token ${token} on "${out.name}"`);
      } catch (e) {
        sendError = e;
        console.warn(`[c100] send failed on "${out.name}":`, e.name, e.message);
        continue;
      }
      const reply = await got;
      if (reply) {
        devOut = out;
        devIn = reply.input;
        connected = true;
        setControls(true);
        setStatus(`C100 connected · fw ${reply.fw}`, "connected");
        console.log(`[c100] connected via "${out.name}" <- "${reply.input.name}"`);
        return;
      }
    }
    if (sendError && sendError.name === "InvalidAccessError")
      setStatus("Allow MIDI SysEx access, then reload", "error");
    else
      setStatus("Searching for C100…");          // not found yet — retry loop keeps going
  }

  function onMidi(ev) {
    const d = [...ev.data];
    if (d[0] === 0xF0)
      console.log(`[c100] <- sysex (${d.length}B) on "${ev.currentTarget.name}": ${d.slice(0, 10).map(b => b.toString(16).padStart(2, "0")).join(" ")}${d.length > 10 ? " …" : ""}`);
    if (!startsWith(d, PREFIX) || d[d.length - 1] !== 0xF7) return;
    const cmd = d[6];

    if (cmd === CMD.DISCOVER_REPLY && d.length >= 13) {
      const token = d[7];
      const res = pendingAcks.get("disc:" + token);
      if (res) {
        pendingAcks.delete("disc:" + token);
        res({ input: ev.currentTarget, proto: d[8], fw: `${d[9]}.${d[10]}.${d[11]}`, caps: d[12] });
      }
      return;
    }

    if (cmd === CMD.PAL_ACK && d.length >= 10) {
      const key = `ack:${d[7]}:${d[8]}`;
      const p = pendingAcks.get(key);
      if (p) { pendingAcks.delete(key); p(d[9] === 0); }
      return;
    }

    if (cmd === CMD.PAL_DATA && d.length >= 9 + PALETTE_SIZE) {
      const key = `data:${d[7]}:${d[8]}`;
      const p = pendingReads.get(key);
      if (p) {
        pendingReads.delete(key);
        p(d.slice(9, 9 + PALETTE_SIZE).map(v => v & 0x3F));
      }
      return;
    }
  }

  function waitAck(slot, comp, ms = 2000) {
    return new Promise((res, rej) => {
      const key = `ack:${slot}:${comp}`;
      const t = setTimeout(() => { pendingAcks.delete(key); rej(new Error("device timeout")); }, ms);
      pendingAcks.set(key, ok => { clearTimeout(t); ok ? res() : rej(new Error("device rejected")); });
    });
  }
  function waitData(slot, comp, ms = 2500) {
    return new Promise((res, rej) => {
      const key = `data:${slot}:${comp}`;
      const t = setTimeout(() => { pendingReads.delete(key); rej(new Error("device timeout")); }, ms);
      pendingReads.set(key, v => { clearTimeout(t); res(v); });
    });
  }

  // ---- palette editor ---------------------------------------------------
  function renderPalette() {
    const grid = $("paletteGrid");
    grid.innerHTML = "";
    for (const i of GRID_ORDER) {
      const rgb6 = palette[i];
      const b = document.createElement("button");
      b.className = "swatch" + (i === selectedIndex ? " selected" : "");
      b.dataset.idx = i;
      const [r, g, bl] = rgb6.map(expand6to8);
      b.style.background = `rgb(${r},${g},${bl})`;
      b.title = `Index ${i} · ${rgb6[0]} ${rgb6[1]} ${rgb6[2]}`;
      b.addEventListener("click", () => selectIndex(i));
      grid.appendChild(b);
    }
  }
  function selectIndex(i) {
    selectedIndex = i;
    $("selectedIndex").textContent = `Index ${i}`;
    const hex = "#" + palette[i].map(v => expand6to8(v).toString(16).padStart(2, "0")).join("");
    $("colorPicker").value = hex;
    $("colorHex").textContent = `${palette[i][0]} ${palette[i][1]} ${palette[i][2]}`;
    [...$("paletteGrid").children].forEach(el => el.classList.toggle("selected", +el.dataset.idx === i));
  }
  function setColorFromHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    palette[selectedIndex] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(compress8to6);
    renderPalette(); selectIndex(selectedIndex);
  }

  function selectSlot(s) {
    selectedSlot = s;
    [...document.querySelectorAll(".slot-button")].forEach(b => b.classList.toggle("active", +b.dataset.slot === s));
  }

  async function uploadPalette() {
    if (!connected) return toast("C100 is not connected.");
    const btn = $("uploadButton"); btn.disabled = true;
    try {
      toast(`Uploading to Slot ${selectedSlot + 1}…`);
      for (let comp = 0; comp < 3; comp++) {
        const ack = waitAck(selectedSlot, comp);
        devOut.send([...PREFIX, CMD.PAL_UPLOAD, selectedSlot, comp,
                     ...palette.map(rgb => rgb[comp] & 0x3F), 0xF7]);
        await ack;
      }
      const commitAck = waitAck(0x7F, 0x7F, 4000);
      devOut.send(msg(CMD.PAL_COMMIT));
      await commitAck;
      toast(`Slot ${selectedSlot + 1} saved to device flash.`, true);
    } catch (e) { console.error(e); toast(`Upload failed: ${e.message}`); }
    finally { btn.disabled = false; }
  }

  async function downloadPalette() {
    if (!connected) return toast("C100 is not connected.");
    const btn = $("downloadButton"); btn.disabled = true;
    try {
      toast(`Reading Slot ${selectedSlot + 1}…`);
      const comps = [];
      for (let comp = 0; comp < 3; comp++) {
        const rep = waitData(selectedSlot, comp);
        devOut.send(msg(CMD.PAL_DOWNLOAD, selectedSlot, comp));
        comps.push(await rep);
      }
      for (let i = 0; i < PALETTE_SIZE; i++) palette[i] = [comps[0][i], comps[1][i], comps[2][i]];
      renderPalette(); selectIndex(selectedIndex);
      toast(`Slot ${selectedSlot + 1} loaded into the editor.`, true);
    } catch (e) { console.error(e); toast(`Download failed: ${e.message}`); }
    finally { btn.disabled = false; }
  }

  function exportPalette() {
    const text = palette.map((rgb, i) => `${i}, ${rgb[0]} ${rgb[1]} ${rgb[2]};`).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = "c100-palette.txt";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Palette exported.", true);
  }
  async function importPalette(file) {
    try {
      const text = await file.text();
      const out = Array(PALETTE_SIZE);
      for (const raw of text.split(/;|\r?\n/)) {
        const m = raw.trim().match(/^(\d+)\s*,\s*(\d+)\s+(\d+)\s+(\d+)$/);
        if (!m) continue;
        const idx = +m[1];
        if (idx < 0 || idx >= PALETTE_SIZE) continue;
        const rgb = [+m[2], +m[3], +m[4]];
        if (rgb.some(v => v < 0 || v > 63)) throw new Error(`value out of 0-63 range at index ${idx}`);
        out[idx] = rgb;
      }
      if (out.some(v => !v)) throw new Error("file must define index 0 through 127");
      out.forEach((rgb, i) => palette[i] = rgb);
      renderPalette(); selectIndex(selectedIndex);
      toast("Palette imported.", true);
    } catch (e) { console.error(e); toast(`Import failed: ${e.message}`); }
  }

  // ---- firmware flashing ----------------------------------------------

  let driverConfirmed = false;
  function isWindows() {
    const p = (navigator.userAgentData && navigator.userAgentData.platform) ||
              navigator.platform || navigator.userAgent || "";
    return /win/i.test(p);
  }
  // Windows-only gate: WinUSB must be bound to the bootloader first.
  function askDriverInstalled() {
    return new Promise(resolve => {
      const m = $("driverModal");
      const yes = $("driverYes"), no = $("driverNo");
      const done = v => { m.hidden = true; yes.onclick = no.onclick = null; resolve(v); };
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
      m.hidden = false;
    });
  }

  function fwStatus(text, state = "idle", pct = null) {
    $("firmwareUpdateStatus").textContent = text;
    $("firmwareUpdateStatus").dataset.state = state;
    if (pct != null) $("firmwareProgressBar").style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  function setFlashing(b) {
    flashing = b;
    $("firmwareUpdateButton").disabled = b;
    document.querySelectorAll('input[name="firmwareSource"]').forEach(i => i.disabled = b);
  }

  // Resolve the latest official Keychron C100 firmware (URL + version) from their API.
  async function resolveOriginalFirmware() {
    const res = await fetch(cfg.keychronFirmwareApi, { cache: "no-store" });
    if (!res.ok) throw new Error(`Keychron firmware API unavailable (${res.status})`);
    const j = await res.json();
    const list = (j && j.data && j.data.list) || [];
    if (!list.length) throw new Error("no official firmware listed");
    const latest = list[0];                       // API returns newest first
    const p = String(latest.path || "");
    const url = /^https?:\/\//i.test(p) ? p : cfg.keychronStaticBase + p.replace("upload/", "");
    return { url, version: latest.version || "?" };
  }

  async function loadImage() {
    const src = document.querySelector('input[name="firmwareSource"]:checked')?.value || "custom";
    let bytes;
    if (src === "original") {
      const { url, version } = await resolveOriginalFirmware();
      fwStatus(`Downloading official firmware v${version}…`, "working", 4);
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`official firmware download failed (${res.status})`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      const res = await fetch(cfg.firmwareUrl, { cache: "no-store" });
      if (!res.ok) throw new Error("custom firmware bundle unavailable");
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    return C100DFU.parseFirmware(bytes, cfg);
  }

  async function refreshOriginalFwLabel() {
    try {
      const { version } = await resolveOriginalFirmware();
      const el = $("originalFwDesc");
      if (el) el.textContent = `Latest official Keychron firmware · v${version}`;
    } catch (_) { /* keep the default label */ }
  }

  function dfuFilter() { return [{ vendorId: cfg.dfuVendorId, productId: cfg.dfuProductId }]; }
  async function findDfu() {
    if (!("usb" in navigator)) return null;
    const list = await navigator.usb.getDevices();
    return list.find(d => d.vendorId === cfg.dfuVendorId && d.productId === cfg.dfuProductId) || null;
  }

  async function flash(device, image) {
    const dfu = new C100DFU.DfuSeDevice(device, { sectorSize: cfg.sectorSize });
    setFlashing(true);
    try {
      fwStatus("Connecting to bootloader…", "working", 8);
      await dfu.open();

      fwStatus("Erasing…", "working", 12);
      await dfu.erase(image.startAddress, image.data.length, (d, t) =>
        fwStatus(`Erasing… ${d}/${t}`, "working", 12 + (d / t) * 18));

      fwStatus("Writing… 0%", "working", 32);
      await dfu.write(image.startAddress, image.data, (d, t) =>
        fwStatus(`Writing… ${Math.round(d / t * 100)}%`, "working", 32 + (d / t) * 40));

      fwStatus("Verifying… 0%", "working", 74);
      try {
        const back = await dfu.read(image.startAddress, image.data.length, (d, t) =>
          fwStatus(`Verifying… ${Math.round(d / t * 100)}%`, "working", 74 + (d / t) * 20));
        let bad = -1;
        for (let i = 0; i < image.data.length; i++)
          if (back[i] !== image.data[i]) { bad = i; break; }
        if (bad >= 0)
          throw new Error(`verify mismatch at 0x${(image.startAddress + bad).toString(16)}`);
        fwStatus("Verified.", "working", 94);
      } catch (e) {
        if (/verify mismatch/.test(e.message)) throw e;
        // AT32 system-memory bootloader often has no UPLOAD (read-back) support;
        // the write path is already checked by GET_STATUS after every block.
        console.warn("[dfu] read-back verify unavailable, skipped:", e.message);
        fwStatus("Verify skipped (bootloader has no read-back)…", "working", 94);
      }

      fwStatus("Restarting C100…", "working", 97);
      await dfu.leave();
      fwStatus("Update complete.", "ok", 100);
    } catch (e) {
      console.error(e);
      fwStatus(`Update failed: ${e.message}`, "error");
    } finally {
      await dfu.close();
      setFlashing(false);
      if (midi) discover();
    }
  }

  // When the browser's WebUSB chooser is needed, it must be opened from a *direct*
  // click (transient user activation). Rebooting into the bootloader takes seconds
  // of awaits, which spends that activation — so we split the flow: phase 1 gets
  // the board into DFU, phase 2 (the next UPDATE click) opens the chooser.
  let awaitingDevicePick = false;

  async function beginFlash(device) {
    setFlashing(true);
    try {
      const image = await loadImage();
      await flash(device, image);            // flash() owns its own error handling + cleanup
    } catch (e) {
      console.error(e);
      fwStatus(`Update failed: ${e.message}`, "error", 0);
      setFlashing(false);
    }
  }

  async function updateFirmware() {
    if (flashing) return;
    if (!("usb" in navigator)) return fwStatus("WebUSB needs Chrome/Edge over HTTPS.", "error", 0);

    // Phase 2 — this click exists only to open the WebUSB chooser.
    if (awaitingDevicePick) {
      awaitingDevicePick = false;
      let device;
      try {
        device = await navigator.usb.requestDevice({ filters: dfuFilter() });
      } catch (e) {
        return fwStatus(e && e.name === "NotFoundError"
          ? "No bootloader selected — click UPDATE to try again."
          : `Could not open the device: ${e.message}`, "error", 0);
      }
      return beginFlash(device);
    }

    // Windows: WinUSB must be bound to the bootloader first.
    if (isWindows() && !driverConfirmed) {
      const ok = await askDriverInstalled();
      if (!ok) { window.location.href = "zadig.html"; return; }
      driverConfirmed = true;
    }

    // Phase 1 — do we already have the bootloader, or can we summon it?
    let device = await findDfu();
    let rebooted = false;
    if (!device && connected && devOut) {
      fwStatus("Rebooting the C100 into its bootloader…", "working", 4);
      try { devOut.send(msg(CMD.ENTER_BOOTLOADER)); rebooted = true; } catch (_) {}
      for (let i = 0; i < 16 && !device; i++) { await sleep(250); device = await findDfu(); }
    }
    if (device) return beginFlash(device);

    // Otherwise the chooser is required; ask for a fresh click.
    awaitingDevicePick = true;
    fwStatus(rebooted
      ? 'C100 is entering its bootloader — click UPDATE again, then pick "DFU in FS Mode".'
      : 'Put the C100 in bootloader mode (hold the top-left key while plugging in USB), then click UPDATE again and pick "DFU in FS Mode".',
      "working", 0);
  }

  // ---- ui plumbing ---------------------------------------------------
  function setStatus(text, state = "searching") {
    const el = $("deviceStatus"); el.textContent = text; el.dataset.state = state;
  }
  function setControls(on) { $("deviceOnlyControls").hidden = !on; }
  function toast(text, good = false) {
    const el = $("toast"); el.textContent = text; el.style.color = good ? "var(--ok)" : "var(--muted)";
  }
  function setupNav() {
    document.querySelectorAll(".dock-button[data-page]").forEach(btn => {
      btn.addEventListener("click", () => {
        const page = btn.dataset.page;
        document.querySelectorAll(".dock-button[data-page]").forEach(b => b.classList.toggle("active", b === btn));
        $("firmwarePage").classList.toggle("active", page === "firmware");
        $("palettePage").classList.toggle("active", page === "palette");
      });
    });
  }

  function init() {
    $("madeWithName").textContent = cfg.madeWithName || "PeelDok";
    setControls(false);
    renderPalette(); selectIndex(0); selectSlot(0);
    setupNav();

    $("colorPicker").addEventListener("input", e => setColorFromHex(e.target.value));
    $("uploadButton").addEventListener("click", uploadPalette);
    $("downloadButton").addEventListener("click", downloadPalette);
    $("exportButton").addEventListener("click", exportPalette);
    $("importButton").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", e => { const f = e.target.files?.[0]; if (f) importPalette(f); e.target.value = ""; });
    document.querySelectorAll(".slot-button").forEach(b => b.addEventListener("click", () => selectSlot(+b.dataset.slot)));

    $("firmwareUpdateButton").addEventListener("click", updateFirmware);
    $("githubButton").addEventListener("click", () => window.open(cfg.githubUrl, "_blank", "noopener"));

    setupMidi();
    refreshOriginalFwLabel();
  }

  init();
})();
