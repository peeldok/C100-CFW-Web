window.C100_CONFIG = {
  githubUrl: "https://github.com/peeldok/C100",
  madeWithName: "PeelDok",

  // "Custom Firmware": this project's grid firmware, bundled with the site (raw .bin @ 0x08000000).
  firmwareUrl: "./firmware/c100.bin",
  // "Original Firmware": Keychron's official C100 8K firmware API. The bin path in the
  // response is relative; resolve it as keychronStaticBase + path.replace("upload/", "").
  keychronFirmwareApi: "https://launcher.keychron.com/vapi/v2/firmware/875824172",
  keychronStaticBase: "https://launcher.keychron.com/static/",

  // AT32F405 system-memory ROM bootloader (DfuSe, same protocol family as STM32 0483:df11)
  dfuVendorId: 0x2E3C,
  dfuProductId: 0xDF11,

  flashOrigin: 0x08000000,
  flashSize: 0x40000,        // 256 KB
  sectorSize: 0x800,         // 2 KB erase page
  appReserveTop: 0x1000      // top 4 KB reserved for the C100 NVS (never flashed / erased)
};
