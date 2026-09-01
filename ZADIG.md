# Windows: one-time USB driver setup (Zadig)

**macOS and Linux users: skip this — nothing to install.**

The very first time you flash a C100 from Windows, the browser cannot reach the
board's ROM bootloader until Windows has a driver bound to it. You assign the
generic **WinUSB** driver once with a small free tool called **Zadig**. After
that, every future flash from the C100 WebEditor just works.

---

## 1. Get Zadig

[Download](https://github.com/pbatard/libwdi/releases/download/v1.5.1/zadig-2.9.exe)
from [zadig.akeo.ie](https://zadig.akeo.ie) — a single executable, no installation.

## 2. Enter the C100 into bootloader mode

Hold the **top-left corner key** while plugging in the USB cable. Windows detects
a new device — it appears as **DFU in FS Mode** (USB ID `2E3C:DF11`) with no
driver yet.

```
                 ╥  ← USB cable (top)
   ┌─────────────╨───────────────────┐
   │  ▣   ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢   ▢  │   ▣ = hold this key (top-left)
   │  ▢   ▢  ▢  ▢  ▢  ▢  ▢  ▢  ▢   ▢  │
   │  ▫   ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫   ▫  │
   │  ·   ·  ·  ·  ·  ·  ·  ·  ·   ·  │
   │                                 │
   └─────────────────────────────────┘   (lower rows fade into the dark)
```

## 3. Run Zadig

1. Start `zadig-2.9.exe` (accept the UAC prompt — it needs admin to install a driver).
2. In the dropdown, select **DFU in FS Mode**. If it is not listed, tick
   **Options → List All Devices**.
3. Check the **USB ID** field reads **2E3C / DF11** and **Driver** shows
   **(NONE)** — do **not** pick a mouse, hub, or your other keyboard.
4. In the driver box to the right of the green arrow, choose **WinUSB**.
5. Click **Install Driver**. It takes ~10–30 seconds.
6. When it says the driver was installed successfully, close Zadig.

## 4. Flash

Unplug and re-plug the C100, open the C100 WebEditor, and click **UPDATE** on the
Firmware page. Chrome/Edge will show a device picker — choose the C100 bootloader
and let it flash.

---

## Verify (optional)

Device Manager → **Universal Serial Bus devices** → you should see the C100
bootloader listed with the WinUSB driver.

## Undo (optional)

Device Manager → right-click the entry → **Uninstall device** → tick
*Delete the driver software for this device*. Or just run Zadig again.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `2E3C DF11` not in the list | Tick **Options → List All Devices**; make sure the board is actually in bootloader mode. |
| "The system cannot find the file specified" during install | Re-run Zadig as administrator; try **Replace Driver** again. |
| WebEditor still can't find the device after install | Unplug/replug, fully close and reopen the browser. |
| You changed the driver on the wrong device | Device Manager → that device → Uninstall device (delete driver) → unplug/replug so Windows restores its normal driver. |

