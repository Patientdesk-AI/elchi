# Eshlik on Omarchy (Arch Linux + Hyprland)

Packaging and desktop integration for [Omarchy](https://omarchy.org). The
package repacks the official `.deb` release (prebuilt, hence `elchi-bin`), and
`elchi-omarchy-setup` wires it into Hyprland. Nothing here changes the app.

## Install

- **Omarchy's own repository** (once the recipe in
  [omarchy-pkgs](https://github.com/omacom/omarchy-pkgs) is merged):
  `sudo pacman -S elchi`, updated by `omarchy update` like everything else.
- **AUR**: `yay -S elchi-bin` (published as soon as AUR account registration
  reopens; the package provides `elchi`).
- **From this checkout**: `cd omarchy && makepkg -si`

Then bind the key:

```bash
elchi-omarchy-setup
```

Eshlik downloads Duyu-small (56 MB, Turkish + English, CPU) on first run.

## What the setup does

- Appends a managed block to `~/.config/hypr/bindings.lua` (a timestamped
  backup is kept next to it), then `hyprctl reload`. Re-run to change the key,
  `--remove` to take it out.
- Default key, picked per machine and changeable with `--key`:
  1. **Fn** (`XF86Fn`) when the keyboard reports a real Fn key. Most laptops
     handle Fn in firmware and never do; the setup checks `/proc/bus/input/devices`.
  2. **ROG key** (`XF86Launch1`) on ASUS laptops.
  3. **Ctrl + Space** otherwise, Eshlik's own default shortcut. It is also
     fcitx5's input-method toggle; input-method users should pick another key.

  Omarchy leaves `Pause`, `Menu` and `SUPER + ALT + V` free too. Hold mode
  binds press and release, so hold-to-talk is two toggles; if a release is
  missed (modifier let go first), press once more.

- The chosen key is written into Eshlik's settings as `external_shortcut`, so
  Settings > General shows it in place of the in-app shortcut (which cannot
  capture keys on Wayland). Eshlik is restarted for that.
- Until the first run is finished: turns on the recording overlay (Linux
  hides it by default) with its idle line, and "Start at login". Tick "Start
  hidden" under Settings > Advanced if you do not want the window at login.
  The key only toggles a running Eshlik.

```bash
elchi-omarchy-setup --key Pause                # another free key (Menu works too)
elchi-omarchy-setup --key "SUPER + ALT + V" --mode toggle
```

## How it fits Omarchy

| Piece     | How                                                                                   |
| --------- | ------------------------------------------------------------------------------------- |
| Hotkey    | Hyprland bind → `elchi --toggle-transcription` (in-app global shortcuts are X11-only) |
| Typing    | `wtype` (Eshlik picks it on Wayland); `wl-copy` for clipboard pastes                  |
| Overlay   | Eshlik's recording pill via GTK layer shell, on the monitor under the cursor          |
| Tray      | `omarchy.tray` shows Eshlik's icon                                                    |
| Autostart | Eshlik's own XDG autostart entry; uwsm runs `xdg-desktop-autostart.target`            |
| Updates   | pacman. `/usr/lib/environment.d/50-elchi.conf` sets `HANDY_DISABLE_UPDATER=1`         |

## Releasing a new version (maintainer)

The Omarchy recipe watches GitHub releases of this repository and bumps itself.
For the AUR package:

```bash
cd omarchy
sed -i 's/^pkgver=.*/pkgver=1.0.3/; s/^pkgrel=.*/pkgrel=1/' PKGBUILD
updpkgsums && makepkg --printsrcinfo > .SRCINFO && makepkg -si   # smoke test locally
cp PKGBUILD .SRCINFO elchi-bin.install elchi-omarchy-setup ../../aur-elchi-bin/ && cd ../../aur-elchi-bin
git add -A && git commit -m "Update to 1.0.3" && git push
```

AUR bootstrap, once: register at <https://aur.archlinux.org> with your SSH
public key, then `git clone ssh://aur@aur.archlinux.org/elchi-bin.git aur-elchi-bin`
(the empty repo is created by the first push).
