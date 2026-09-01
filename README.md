# C100 WebEditor

WebMIDI custom-palette editor and WebUSB firmware flasher for the Keychron C100
grid controller firmware.

Requires Chrome or Edge over HTTPS (WebMIDI + WebUSB).

## Pages

- **Firmware** — two sources: *Custom Firmware* (the bundled `firmware/c100.bin`,
  this project's grid firmware) and *Original Firmware* (the latest official
  Keychron C100 8K image, fetched live from `launcher.keychron.com`).
  The C100 is rebooted into its AT32F405 ROM bootloader automatically over SysEx;
  only the application area is erased, so the NVS sectors (settings + custom
  palettes) survive an update. Read-back verify is skipped when the ROM
  bootloader has no UPLOAD support.
- **Custom Palette** — edit a 128-entry velocity→RGB palette (6-bit per channel).
  Opens on the built-in *Original* palette (`palettes.js`, generated from
  `firmware/assets/palettes.h`). Swatches are laid out as two 8-wide banks per
  row: indices 0–63 on the left, 64–127 on the right.
  *Import / Export* read and write `index, R G B;` text files. *Slot 1/2/3* pick a
  device custom-palette slot; *Download* pulls it into the editor, *Upload* writes
  the editor palette to that slot and commits it to flash.

## Protocol

SysEx `F0 7D 43 31 30 30 <cmd> … F7` ("C100"), see `firmware/sysex.c`:
`0x01` discover · `0x10` palette upload · `0x12` palette download · `0x14` commit ·
`0x20` enter bootloader.

## Windows driver

First-time flashing on Windows needs WinUSB bound to the bootloader (`2E3C:DF11`)
once — see `zadig.html` (linked from the Firmware page). macOS / Linux need
nothing.

## Hosting

Static site — drop into a GitHub Pages repo. `dfu.js` is a compact DfuSe
(ST/Artery `df11`) implementation derived from devanlai/webdfu (MIT).
