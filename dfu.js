/* Minimal DfuSe (ST/Artery "0xDF11" style) WebUSB flasher for the C100.
 *
 * The AT32F405 system-memory ROM bootloader speaks the same DfuSe dialect as
 * STM32 (ST app note AN3156): standard DFU requests plus block-0 DNLOAD
 * commands 0x21 (set address pointer) and 0x41 (erase page). Page erase is used
 * so the top NVS sectors survive a firmware update.
 *
 * Reference behaviour: devanlai/webdfu (MIT).  Verify on hardware.
 */
(() => {
  const REQ = { DETACH: 0, DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, GETSTATE: 5, ABORT: 6 };
  const STATE = { dfuIDLE: 2, dfuDNLOAD_SYNC: 3, dfuDNBUSY: 4, dfuDNLOAD_IDLE: 5,
                  dfuMANIFEST_SYNC: 6, dfuMANIFEST: 7, dfuUPLOAD_IDLE: 9, dfuERROR: 10 };
  const STATUS_STR = ["OK","errTARGET","errFILE","errWRITE","errERASE","errCHECK_ERASED",
    "errPROG","errVERIFY","errADDRESS","errNOTDONE","errFIRMWARE","errVENDOR","errUSBR",
    "errPOR","errUNKNOWN","errSTALLEDPKT"];

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---- firmware image ----------------------------------------------------

  function parseIntelHex(text) {
    const chunks = [];               // { addr, bytes }
    let base = 0, eof = false;
    let lo = Infinity, hi = -1;
    for (const raw of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line[0] !== ":") throw new Error("HEX: missing ':'");
      const b = [];
      for (let i = 1; i < line.length; i += 2) b.push(parseInt(line.substr(i, 2), 16));
      const len = b[0], off = (b[1] << 8) | b[2], type = b[3];
      let sum = 0; for (const v of b) sum = (sum + v) & 0xFF;
      if (sum !== 0) throw new Error("HEX: checksum error");
      const data = b.slice(4, 4 + len);
      if (type === 0) {
        const a = base + off;
        chunks.push({ addr: a, bytes: Uint8Array.from(data) });
        lo = Math.min(lo, a); hi = Math.max(hi, a + len);
      } else if (type === 1) { eof = true; break; }
      else if (type === 2) base = ((data[0] << 8) | data[1]) << 4;
      else if (type === 4) base = ((data[0] << 8) | data[1]) << 16;
      else if (type !== 3 && type !== 5) throw new Error("HEX: unsupported record " + type);
    }
    if (!eof) throw new Error("HEX: no EOF record");
    if (hi < 0) throw new Error("HEX: no data");
    const data = new Uint8Array(hi - lo).fill(0xFF);
    for (const c of chunks) data.set(c.bytes, c.addr - lo);
    return { startAddress: lo, data };
  }

  // input: string (Intel HEX) or ArrayBuffer/Uint8Array (raw .bin at flashOrigin)
  function parseFirmware(input, opts = {}) {
    const origin = Number(opts.flashOrigin ?? 0x08000000);
    const flashSize = Number(opts.flashSize ?? 0x40000);
    const reserveTop = Number(opts.appReserveTop ?? 0);
    let img;
    if (typeof input === "string" && input.trim().startsWith(":")) {
      img = parseIntelHex(input);
    } else {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      img = { startAddress: origin, data: bytes };
    }
    if (img.startAddress < origin || img.startAddress + img.data.length > origin + flashSize)
      throw new Error("Firmware image is outside the AT32F405 flash");
    if (img.startAddress + img.data.length > origin + flashSize - reserveTop)
      throw new Error("Firmware image overlaps the reserved NVS area");
    return img;
  }

  // ---- device ----------------------------------------------------------

  class DfuSeDevice {
    constructor(device, opts = {}) {
      this.device = device;
      this.ifaceNumber = 0;
      this.altSetting = 0;
      this.transferSize = Number(opts.transferSize ?? 2048);
      this.sectorSize = Number(opts.sectorSize ?? 0x800);
    }

    async open() {
      if (!this.device.opened) await this.device.open();
      if (!this.device.configuration) await this.device.selectConfiguration(1);

      let found = null, funcDesc = null;
      for (const iface of this.device.configuration.interfaces) {
        for (const alt of iface.alternates) {
          if (alt.interfaceClass === 0xFE && alt.interfaceSubclass === 0x01) {
            found = { n: iface.interfaceNumber, alt: alt.alternateSetting };
            break;
          }
        }
        if (found) break;
      }
      if (!found) throw new Error("No DFU interface on the bootloader device");
      this.ifaceNumber = found.n;
      this.altSetting = found.alt;
      await this.device.claimInterface(this.ifaceNumber);
      const iface = this.device.configuration.interfaces.find(i => i.interfaceNumber === this.ifaceNumber);
      if (iface && iface.alternate.alternateSetting !== this.altSetting)
        await this.device.selectAlternateInterface(this.ifaceNumber, this.altSetting);

      // wTransferSize: df11 bootloaders use 2048. (A standalone GET_DESCRIPTOR
      // for the DFU functional descriptor can STALL the control pipe on some
      // bootloaders, so it is not requested.)
      void funcDesc;
      await this.abort().catch(() => {});
      try { await this.getStatus(); } catch (_) {}
      await this.clearIfError();
      console.log(`[dfu] open ok · iface ${this.ifaceNumber} alt ${this.altSetting} · xfer ${this.transferSize}`);
    }

    _setup(request, value) {
      return { requestType: "class", recipient: "interface", request, value: value & 0xFFFF, index: this.ifaceNumber };
    }
    async _out(request, value, data) {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.device.controlTransferOut(this._setup(request, value), data ?? new Uint8Array(0));
          if (r.status === "stall") { await this.device.clearHalt("out", 0).catch(() => {}); throw new Error("OUT stall"); }
          if (r.status !== "ok") throw new Error("USB OUT " + r.status);
          return r.bytesWritten ?? 0;
        } catch (e) {
          if (attempt >= 2) throw e;
          await sleep(40);
        }
      }
    }
    async _in(request, value, length) {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.device.controlTransferIn(this._setup(request, value), length);
          if (r.status === "stall") { await this.device.clearHalt("in", 0).catch(() => {}); throw new Error("IN stall"); }
          if (r.status !== "ok" || !r.data) throw new Error("USB IN " + r.status);
          return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        } catch (e) {
          if (attempt >= 2) throw e;
          await sleep(40);
        }
      }
    }

    dnload(block, data) { return this._out(REQ.DNLOAD, block, data); }
    upload(block, length) { return this._in(REQ.UPLOAD, block, length); }
    async getStatus() {
      const d = await this._in(REQ.GETSTATUS, 0, 6);
      return { status: d[0], poll: d[1] | (d[2] << 8) | (d[3] << 16), state: d[4] };
    }
    clearStatus() { return this._out(REQ.CLRSTATUS, 0); }
    abort() { return this._out(REQ.ABORT, 0); }

    describe(s) { return `${STATUS_STR[s.status] || s.status} / state ${s.state}`; }

    async clearIfError() {
      let s;
      try { s = await this.getStatus(); } catch (_) { return; }
      if (s.state === STATE.dfuERROR || s.status !== 0) {
        await this.clearStatus().catch(() => {});
        await sleep(20);
      }
    }

    // poll GETSTATUS until the device leaves a busy/sync state
    async poll(timeoutMs = 20000) {
      const t0 = Date.now();
      // first status kicks the operation and returns bwPollTimeout
      let s = await this.getStatus();
      while (s.state === STATE.dfuDNBUSY || s.state === STATE.dfuDNLOAD_SYNC ||
             s.state === STATE.dfuMANIFEST || s.state === STATE.dfuMANIFEST_SYNC) {
        if (Date.now() - t0 > timeoutMs) throw new Error("DFU operation timed out");
        await sleep(Math.max(5, Math.min(s.poll || 5, 1000)));
        s = await this.getStatus();
      }
      if (s.status !== 0) {
        if (s.state === STATE.dfuERROR) await this.clearStatus().catch(() => {});
        throw new Error("DFU error: " + this.describe(s));
      }
      return s;
    }

    _cmd(bytes) { return this.dnload(0, Uint8Array.from(bytes)); }
    _addrBytes(addr) { return [addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF, (addr >> 24) & 0xFF]; }

    async setAddress(addr) {
      try {
        await this._cmd([0x21, ...this._addrBytes(addr)]);
        await this.poll();
      } catch (e) { throw new Error(`set-address 0x${addr.toString(16)}: ${e.message}`); }
    }
    async erasePage(addr) {
      try {
        await this._cmd([0x41, ...this._addrBytes(addr)]);
        await this.poll(5000);
      } catch (e) { throw new Error(`erase 0x${addr.toString(16)}: ${e.message}`); }
    }

    async erase(startAddr, length, onProgress = () => {}) {
      const first = startAddr - (startAddr % this.sectorSize);
      const lastByte = startAddr + length - 1;
      const last = lastByte - (lastByte % this.sectorSize);
      const pages = (last - first) / this.sectorSize + 1;
      let done = 0;
      for (let a = first; a <= last; a += this.sectorSize) {
        await this.erasePage(a);
        onProgress(++done, pages);
      }
    }

    async write(startAddr, data, onProgress = () => {}) {
      await this.abort().catch(() => {});
      await this.setAddress(startAddr);
      const total = data.length;
      let sent = 0, block = 2;
      while (sent < total) {
        const len = Math.min(this.transferSize, total - sent);
        try {
          await this.dnload(block++, data.subarray(sent, sent + len));
          await this.poll();
        } catch (e) { throw new Error(`write @0x${(startAddr + sent).toString(16)}: ${e.message}`); }
        sent += len;
        onProgress(sent, total);
      }
    }

    async read(startAddr, length, onProgress = () => {}) {
      await this.abort().catch(() => {});
      await this.setAddress(startAddr);
      const out = new Uint8Array(length);
      let got = 0, block = 2;
      while (got < length) {
        const want = Math.min(this.transferSize, length - got);
        let chunk;
        try { chunk = await this.upload(block++, want); }
        catch (e) { throw new Error(`read @0x${(startAddr + got).toString(16)}: ${e.message}`); }
        if (chunk.length === 0) break;
        out.set(chunk.subarray(0, Math.min(chunk.length, length - got)), got);
        got += chunk.length;
        onProgress(got, length);
      }
      return out.subarray(0, got);
    }

    async leave() {
      await this.abort().catch(() => {});
      // set address to the app entry, then a zero-length DNLOAD manifests + resets
      await this.setAddress(0x08000000).catch(() => {});
      try { await this.dnload(0, new Uint8Array(0)); await this.poll(4000); } catch (_) {}
    }

    async close() {
      try { if (this.device.opened) await this.device.releaseInterface(this.ifaceNumber); } catch (_) {}
      try { if (this.device.opened) await this.device.close(); } catch (_) {}
    }
  }

  globalThis.C100DFU = { parseFirmware, parseIntelHex, DfuSeDevice, STATUS_STR };
})();
