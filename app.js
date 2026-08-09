(() => {
  const cfg = window.MYSTRIX_CONFIG || {};
  const DISCOVER_PREFIX = [0xF0, 0x7D, 0x4D, 0x59, 0x58, 0x01];
  const REPLY_PREFIX = [0xF0, 0x7D, 0x4D, 0x59, 0x58, 0x02];
  const PROTOCOL_VERSION = 1;
  const PALETTE_SIZE = 128;
  const DEVICE_SETTINGS_REQUEST = [0xF0, 0x7D, 0x4D, 0x59, 0x58, 0x03, 0xF7];
  const DEVICE_SETTINGS_REPLY = [0xF0, 0x7D, 0x4D, 0x59, 0x58, 0x04];
  const DEVICE_SETTINGS_SET_PREFIX = [0xF0, 0x7D, 0x4D, 0x59, 0x58, 0x05];

  let midiAccess = null;
  let mystrixOutput = null;
  let mystrixInput = null;
  let selectedVelocity = 0;
  let releaseDownloadUrl = null;
  let releasePageUrl = null;
  let deviceSettingsDirty = false;
  let lastDeviceSettings = null;
  const pendingDiscoveries = new Map();
  const palette = [[0,0,0],[28,28,28],[124,124,124],[252,252,252],[252,72,72],[252,0,0],[84,0,0],[24,0,0],[252,184,104],[252,80,0],[84,28,0],[36,24,0],[252,252,72],[252,252,0],[84,84,0],[24,24,0],[132,252,72],[80,252,0],[28,84,0],[16,40,0],[72,252,72],[0,252,0],[0,84,0],[0,24,0],[72,252,92],[0,252,24],[0,84,12],[0,24,0],[72,252,132],[0,252,84],[0,84,28],[0,28,16],[72,252,180],[0,252,148],[0,84,52],[0,24,16],[72,192,252],[0,164,252],[0,64,80],[0,12,24],[72,132,252],[0,84,252],[0,28,84],[0,4,24],[72,72,252],[0,0,252],[0,0,84],[0,0,24],[132,72,252],[80,0,252],[24,0,96],[12,0,44],[252,72,252],[252,0,252],[84,0,84],[24,0,24],[252,72,132],[252,0,80],[84,0,28],[32,0,16],[252,20,0],[148,52,0],[116,80,0],[64,96,0],[0,56,0],[0,84,52],[0,80,124],[0,0,252],[0,68,76],[36,0,200],[124,124,124],[28,28,28],[252,0,0],[184,252,44],[172,232,4],[96,252,8],[12,136,0],[0,252,132],[0,164,252],[0,40,252],[60,0,252],[120,0,252],[172,24,120],[60,32,0],[252,72,0],[132,220,4],[112,252,20],[0,252,0],[56,252,36],[84,252,108],[52,252,200],[88,136,252],[48,80,192],[132,124,228],[208,28,252],[252,0,88],[252,124,0],[180,172,0],[140,252,0],[128,88,4],[56,40,0],[16,72,12],[12,76,52],[20,20,40],[20,28,88],[100,56,24],[164,0,8],[216,80,60],[212,104,24],[252,220,36],[156,220,44],[100,176,12],[28,28,44],[216,252,104],[124,252,184],[152,148,252],[140,100,252],[60,60,60],[112,112,112],[220,252,252],[156,0,0],[52,0,0],[24,204,0],[4,64,0],[180,172,0],[60,48,0],[176,92,0],[72,20,0]];

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function bytesStartWith(data, prefix) {
    if (data.length < prefix.length) return false;
    return prefix.every((value, i) => data[i] === value);
  }

  function setDeviceStatus(text, state = "searching") {
    const el = $("deviceStatus");
    el.textContent = text;
    el.dataset.state = state;
  }

  function setDeviceControlsVisible(visible) {
    const controls = $("deviceOnlyControls");
    const settingsButton = $("deviceSettingsButton");

    if (controls) controls.hidden = !visible;

    if (settingsButton) {
      settingsButton.hidden = !visible;
      settingsButton.classList.toggle("device-connected-visible", visible);
      settingsButton.style.display = visible ? "" : "none";
    }

    if (!visible && $("deviceSettingsPage")?.classList.contains("active")) {
      document.querySelectorAll(".dock-button[data-page]").forEach(button => {
        button.classList.toggle("active", button.dataset.page === "firmware");
      });
      $("firmwarePage").classList.add("active");
      $("palettePage").classList.remove("active");
      $("deviceSettingsPage").classList.remove("active");
    }
  }

  function showToast(text, good = false) {
    const el = $("toast");
    el.textContent = text;
    el.style.color = good ? "var(--ok)" : "var(--muted)";
  }

  function toHex(rgb) {
    return "#" + rgb.map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  }

  function hexToRgb(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function renderPalette() {
    const grid = $("paletteGrid");
    grid.innerHTML = "";
    palette.forEach((rgb, index) => {
      const b = document.createElement("button");
      b.className = "swatch" + (index === selectedVelocity ? " selected" : "");
      b.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      b.title = `Velocity ${index} · ${toHex(rgb)}`;
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", () => selectVelocity(index));
      grid.appendChild(b);
    });
  }

  function selectVelocity(index) {
    selectedVelocity = index;
    $("selectedVelocity").textContent = `Velocity ${index}`;
    const hex = toHex(palette[index]);
    $("colorPicker").value = hex;
    $("colorHex").textContent = hex;
    [...$("paletteGrid").children].forEach((el, i) => el.classList.toggle("selected", i === index));
  }

  function updateSelectedColor(hex) {
    palette[selectedVelocity] = hexToRgb(hex);
    $("colorHex").textContent = hex.toUpperCase();
    const swatch = $("paletteGrid").children[selectedVelocity];
    if (swatch) {
      const rgb = palette[selectedVelocity];
      swatch.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      swatch.title = `Velocity ${selectedVelocity} · ${toHex(rgb)}`;
    }
  }


  function decode7Bit16(msb, lsb) {
    return ((msb & 0x7F) << 7) | (lsb & 0x7F);
  }

  function updateDeviceSettingsUi(minVelocity, maxVelocity, minSlope, maxSlope) {
    minVelocity = Math.max(1, Math.min(127, minVelocity));
    maxVelocity = Math.max(minVelocity, Math.min(127, maxVelocity));
    minSlope = Math.max(100, Math.min(10240, minSlope));
    maxSlope = Math.max(minSlope, Math.min(10240, maxSlope));

    const minVelocitySlider = $("minVelocitySlider");
    const maxVelocitySlider = $("maxVelocitySlider");
    const minSlopeSlider = $("minSlopeSlider");
    const maxSlopeSlider = $("maxSlopeSlider");

    minVelocitySlider.value = minVelocity;
    maxVelocitySlider.min = minVelocity;
    maxVelocitySlider.value = maxVelocity;
    minSlopeSlider.value = minSlope;
    maxSlopeSlider.min = minSlope;
    maxSlopeSlider.value = maxSlope;

    $("minVelocityValue").textContent = minVelocity;
    $("maxVelocityValue").textContent = maxVelocity;
    $("minSlopeValue").textContent = minSlope;
    $("maxSlopeValue").textContent = maxSlope;
  }

  function currentDeviceSettings() {
    let minVelocity = Number($("minVelocitySlider").value);
    let maxVelocity = Number($("maxVelocitySlider").value);
    let minSlope = Number($("minSlopeSlider").value);
    let maxSlope = Number($("maxSlopeSlider").value);

    maxVelocity = Math.max(minVelocity, maxVelocity);
    maxSlope = Math.max(minSlope, maxSlope);

    updateDeviceSettingsUi(minVelocity, maxVelocity, minSlope, maxSlope);

    return { minVelocity, maxVelocity, minSlope, maxSlope };
  }

  function buildDeviceSettingsMessage() {
    const { minVelocity, maxVelocity, minSlope, maxSlope } = currentDeviceSettings();
    return [
      ...DEVICE_SETTINGS_SET_PREFIX,
      minVelocity & 0x7F,
      maxVelocity & 0x7F,
      ...encode7Bit16(minSlope),
      ...encode7Bit16(maxSlope),
      0xF7
    ];
  }

  function deviceSettingsKey(settings) {
    return [
      settings.minVelocity,
      settings.maxVelocity,
      settings.minSlope,
      settings.maxSlope
    ].join(":");
  }

  function markDeviceSettingsDirty() {
    currentDeviceSettings();
    deviceSettingsDirty = true;
  }

  function autoUploadDeviceSettings() {
    if (!mystrixOutput || !deviceSettingsDirty) return;

    const settings = currentDeviceSettings();
    const key = deviceSettingsKey(settings);

    if (key === lastDeviceSettings) {
      deviceSettingsDirty = false;
      return;
    }

    try {
      mystrixOutput.send(buildDeviceSettingsMessage());
      lastDeviceSettings = key;
      deviceSettingsDirty = false;
      showToast("Device settings saved.", true);
    } catch (error) {
      console.error(error);
      showToast("Device settings update failed.");
    }
  }

  function requestDeviceSettings() {
    if (!mystrixOutput) return;
    try {
      mystrixOutput.send(DEVICE_SETTINGS_REQUEST);
    } catch (error) {
      console.error(error);
    }
  }

  async function setupMidi() {
    if (!("requestMIDIAccess" in navigator)) {
      setDeviceControlsVisible(false);
      setDeviceStatus("WebMIDI unavailable", "error");
      return;
    }

    try {
      setDeviceControlsVisible(false);
      setDeviceControlsVisible(false);
    setDeviceStatus("Searching for device…");
      midiAccess = await navigator.requestMIDIAccess({ sysex: true });
      midiAccess.onstatechange = () => discoverMystrix();
      for (const input of midiAccess.inputs.values()) input.onmidimessage = handleMidiMessage;
      await discoverMystrix();
    } catch (error) {
      console.error(error);
      setDeviceControlsVisible(false);
      setDeviceStatus("MIDI permission required", "error");
    }
  }

  function refreshInputListeners() {
    if (!midiAccess) return;
    for (const input of midiAccess.inputs.values()) input.onmidimessage = handleMidiMessage;
  }

  async function discoverMystrix() {
    if (!midiAccess) return;
    refreshInputListeners();
    mystrixOutput = null;
    mystrixInput = null;
    deviceSettingsDirty = false;
    lastDeviceSettings = null;
    pendingDiscoveries.clear();
    setDeviceStatus("Searching for device…");

    const outputs = [...midiAccess.outputs.values()];
    if (!outputs.length) {
      setDeviceControlsVisible(false);
      setDeviceStatus("No MIDI device", "error");
      return;
    }

    for (let i = 0; i < outputs.length; i++) {
      const token = (i + 1) & 0x7F;
      pendingDiscoveries.set(token, outputs[i]);
      try {
        outputs[i].send([...DISCOVER_PREFIX, token, 0xF7]);
      } catch (error) {
        console.warn("Discovery send failed", outputs[i].name, error);
      }
      await sleep(15);
    }

    await sleep(450);
    if (!mystrixOutput) {
      setDeviceControlsVisible(false);
      setDeviceStatus("Mystrix not found", "error");
    }
  }

  function handleMidiMessage(event) {
    const data = [...event.data];

    if (bytesStartWith(data, DEVICE_SETTINGS_REPLY) && data[data.length - 1] === 0xF7 && data.length >= 13) {
      const minVelocity = data[6];
      const maxVelocity = data[7];
      const minSlope = decode7Bit16(data[8], data[9]);
      const maxSlope = decode7Bit16(data[10], data[11]);

      updateDeviceSettingsUi(minVelocity, maxVelocity, minSlope, maxSlope);
      lastDeviceSettings = deviceSettingsKey({
        minVelocity,
        maxVelocity,
        minSlope,
        maxSlope
      });
      deviceSettingsDirty = false;
      return;
    }

    if (!bytesStartWith(data, REPLY_PREFIX) || data[data.length - 1] !== 0xF7) return;
    if (data.length < 12) return;

    const token = data[6];
    const protocol = data[7];
    if (protocol !== PROTOCOL_VERSION) return;

    const output = pendingDiscoveries.get(token);
    if (!output) return;

    mystrixOutput = output;
    mystrixInput = event.currentTarget;
    const version = `${data[8]}.${data[9]}.${data[10]}`;
    setDeviceControlsVisible(true);
    setDeviceStatus(`Mystrix ${version} connected`, "connected");
    pendingDiscoveries.clear();
    setTimeout(requestDeviceSettings, 40);
  }

  function encode7Bit16(value) {
    return [(value >> 7) & 0x7F, value & 0x7F];
  }

  function buildPaletteMessage(paletteIndex, component) {
    const msg = [0xF0, 0x7D, paletteIndex & 0x7F, component & 0x7F];
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const value = palette[i][component];
      msg.push(...encode7Bit16(value));
    }
    msg.push(0xF7);
    return msg;
  }

  async function uploadPalette() {
    if (!mystrixOutput) {
      showToast("Mystrix is not connected.");
      await discoverMystrix();
      return;
    }

    const button = $("uploadButton");
    button.disabled = true;
    const paletteIndex = Number($("paletteIndex").value);

    try {
      showToast(`Uploading palette ${paletteIndex + 1}…`);
      for (let component = 0; component < 3; component++) {
        mystrixOutput.send(buildPaletteMessage(paletteIndex, component));
        await sleep(80);
      }
      showToast(`Palette ${paletteIndex + 1} uploaded.`, true);
    } catch (error) {
      console.error(error);
      showToast("Upload failed. Reconnect Mystrix and try again.");
      await discoverMystrix();
    } finally {
      button.disabled = false;
    }
  }

  function exportPalette() {
    const text = palette.map((rgb, i) => `${i}, ${rgb[0]} ${rgb[1]} ${rgb[2]}`).join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mystrix-palette-${Number($("paletteIndex").value) + 1}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Palette exported.", true);
  }

  function parsePaletteText(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      const source = Array.isArray(parsed) ? parsed : parsed.colors;
      if (!Array.isArray(source) || source.length !== 128) throw new Error("JSON must contain 128 colors");
      return source.map((entry, index) => {
        if (Array.isArray(entry) && entry.length >= 3) return entry.slice(0, 3).map(v => Math.max(0, Math.min(255, Number(v) || 0)));
        if (typeof entry === "string" && /^#[0-9a-f]{6}$/i.test(entry)) return hexToRgb(entry);
        throw new Error(`Invalid color at index ${index}`);
      });
    }

    const result = Array(128);
    const entries = trimmed.split(/;|\r?\n/);

    for (const rawEntry of entries) {
      const entry = rawEntry.trim();
      if (!entry || entry.startsWith("#")) continue;

      const match = entry.match(/^(\d+)\s*,\s*(\d+)\s+(\d+)\s+(\d+)$/);
      if (!match) continue;

      const index = Number(match[1]);
      if (index < 0 || index > 127) continue;

      const sourceRgb = [
        Number(match[2]),
        Number(match[3]),
        Number(match[4])
      ];

      if (sourceRgb.some(v => v < 0 || v > 63)) {
        throw new Error(`RGB value out of range at index ${index}. Expected 0-63.`);
      }

      result[index] = sourceRgb.map(v => Math.min(255, v * 4));
    }

    if (result.some(v => !v)) {
      throw new Error("Palette file must define index 0 through 127.");
    }

    return result;
  }

  function applyImportedPalette(imported) {
    imported.forEach((rgb, i) => {
      palette[i] = [rgb[0], rgb[1], rgb[2]];
    });

    const swatches = [...$("paletteGrid").children];
    if (swatches.length !== PALETTE_SIZE) {
      renderPalette();
    } else {
      palette.forEach((rgb, index) => {
        const swatch = swatches[index];
        swatch.style.backgroundColor = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
        swatch.title = `Velocity ${index} · ${toHex(rgb)}`;
        swatch.setAttribute("aria-label", swatch.title);
      });
    }

    selectVelocity(selectedVelocity);
  }

  async function importPalette(file) {
    try {
      const imported = parsePaletteText(await file.text());
      applyImportedPalette(imported);
      showToast("Palette imported.", true);
    } catch (error) {
      console.error(error);
      showToast(`Import failed: ${error.message}`);
    }
  }

  async function loadLatestRelease() {
    const releaseNotes = $("releaseNotes");
    const githubButton = $("githubButton");

    releasePageUrl = "https://github.com/peeldok/Mystrix-CFW";
    githubButton.addEventListener("click", () => {
      window.open(releasePageUrl, "_blank", "noopener");
    });

    try {
      const res = await fetch("./release.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`Release metadata ${res.status}`);

      const release = await res.json();

      releaseDownloadUrl = release.downloadUrl || release.releaseUrl || releasePageUrl;
      releasePageUrl = release.releaseUrl || releasePageUrl;

      $("latestVersion").textContent = release.version || release.tag || "Latest";
      $("releaseMeta").textContent = release.filename || "Open latest GitHub release";

      if (releaseNotes) {
        const notes = (release.notes || "").trim();
        releaseNotes.textContent = notes || "No release notes provided.";
      }

      $("downloadButton").disabled = !releaseDownloadUrl;
    } catch (error) {
      console.error(error);
      $("latestVersion").textContent = "Unavailable";
      $("releaseMeta").textContent = "Could not load release metadata.";
      if (releaseNotes) releaseNotes.textContent = "Release notes unavailable.";
      $("downloadButton").disabled = true;
    }
  }

  function setupNavigation() {
    document.querySelectorAll(".dock-button[data-page]").forEach(button => {
      button.addEventListener("click", () => {
        const page = button.dataset.page;
        document.querySelectorAll(".dock-button[data-page]").forEach(b => b.classList.toggle("active", b === button));
        $("firmwarePage").classList.toggle("active", page === "firmware");
        $("palettePage").classList.toggle("active", page === "palette");
        $("deviceSettingsPage").classList.toggle("active", page === "device-settings");
        if (page === "device-settings") requestDeviceSettings();
      });
    });
  }

  function init() {
    $("madeWithName").textContent = cfg.madeWithName || "PeelDok";
    const deviceSettingsButton = $("deviceSettingsButton");
    if (deviceSettingsButton) {
      deviceSettingsButton.hidden = true;
      deviceSettingsButton.style.display = "none";
    }
    setDeviceControlsVisible(false);
    renderPalette();
    selectVelocity(0);
    setupNavigation();

    $("colorPicker").addEventListener("input", e => updateSelectedColor(e.target.value));
    $("uploadButton").addEventListener("click", uploadPalette);
    $("exportButton").addEventListener("click", exportPalette);
    $("importButton").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", e => {
      const file = e.target.files?.[0];
      if (file) importPalette(file);
      e.target.value = "";
    });
    $("downloadButton").addEventListener("click", () => {
      if (releaseDownloadUrl) window.location.href = releaseDownloadUrl;
    });

    ["minVelocitySlider", "maxVelocitySlider", "minSlopeSlider", "maxSlopeSlider"].forEach(id => {
      $(id).addEventListener("input", markDeviceSettingsDirty);
    });

    updateDeviceSettingsUi(1, 127, 100, 10240);
    setInterval(autoUploadDeviceSettings, 5000);

    loadLatestRelease();
    setupMidi();
  }

  init();
})();
