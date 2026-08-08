# Mystrix Web

Static website for Mystrix CFW firmware downloads and custom palette uploads.

## GitHub setup

Edit `config.js`:

```js
window.MYSTRIX_CONFIG = {
  githubOwner: "YOUR_GITHUB_NAME",
  githubRepo: "YOUR_REPOSITORY",
  madeWithName: "PeelDok"
};
```

The Firmware page requests `GET /repos/{owner}/{repo}/releases/latest` from the GitHub API and prefers a `.uf2` asset for the Download button.

## WebMIDI

The site requires HTTPS or localhost and a browser with WebMIDI SysEx support such as Chromium-based Chrome/Edge.

Device discovery request:

`F0 7D 4D 59 58 01 TT F7`

Device response:

`F0 7D 4D 59 58 02 TT PP MA MI PA F7`

- `TT`: discovery token, echoed by the device
- `PP`: protocol version
- `MA MI PA`: firmware major/minor/patch

V9.4 response is protocol 1, firmware 9.4.0.

## Palette upload

Existing CFW palette protocol is unchanged:

`F0 7D PP CC [128 × MSB LSB] F7`

- `PP`: palette 0..2, displayed as Index 1..3
- `CC`: component 0=R, 1=G, 2=B
- each color value is encoded as two 7-bit bytes

Import/export text format:

```text
0, 0 0 0
1, 255 0 0
...
127, 255 255 255
```

## Palette import format

Text palette files use 128 semicolon-separated entries:

`index, R G B;`

- Index: `0` to `127`
- R/G/B: `0` to `63`
- Imported RGB values are converted to the firmware's 8-bit palette range by multiplying by 4.
- Example: `1, 21 0 0;` becomes RGB `84, 0, 0` in the editor and upload data.
