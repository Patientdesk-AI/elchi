<p align="center">
  <img src="docs/brand/elchi.svg" alt="Elchi" width="96">
</p>

# Elchi

Elchi is a free speech-to-text dictation app for macOS and Windows. Press a shortcut, speak in Turkish, English, or a mix of both, and the text appears wherever your cursor is. For the first 7 days Elchi uses Duyu Pro, our full model in the cloud; after that it runs on your computer with Duyu-small, free and without limits, unless you subscribe to Elchi Pro. The interface is in Turkish, with English as the alternative.

The name comes from the Turkish _elçi_, an envoy or messenger. Elchi carries what you say into text.

## How it works

1. **Press** your keyboard shortcut. Hold it to record and release to stop, or tap it to start and tap again to stop. Hold-only and toggle-only modes are also available.
2. **Speak** while recording is active.
3. **Release** the shortcut. Elchi transcribes the recording on your computer.
4. The text is **pasted** into the app you were using.

Silence is trimmed with Silero voice activity detection before transcription, so pauses do not turn into stray words.

## The default model

Elchi uses [Duyu-small](https://huggingface.co/KaanAydinli/Duyu-small) by default. It is our own model, built for Turkish and English dictation:

- Turkish and English, including code-switching: a sentence that starts in Turkish and finishes in English comes out as one sentence.
- Output is cased and punctuated, so it can be pasted as is.
- 19.3M active parameters. The int8 build is 56 MB.
- Released under the Apache-2.0 license.

Elchi runs Duyu-small natively (`src-tauri/src/duyu/`, a Rust port of the model's reference engine) on ONNX Runtime, on the CPU. It downloads once, about 56 MB, from a pinned revision of the Hugging Face repository, and each file is checked against its SHA-256.

Elchi ships only our own models: Duyu-small on your computer and Duyu Pro in the cloud. Handy's other model families are not offered.

## Elchi Pro

Duyu Pro is the larger speech-to-text model that Duyu-small comes from, with fewer mistakes on fast speech, names and numbers. Every install gets it for 7 days, starting the first time the computer opens Elchi (reinstalling does not restart the trial). After that Elchi switches to Duyu-small on your computer and offers Elchi Pro: ₺200 a month, the first month free, no card needed. **Get Elchi Pro** opens speech.patientdesk.ai, where you sign up or log in and activate it; Elchi notices within a few seconds. If Duyu Pro can't be reached, Elchi carries on with Duyu-small. Duyu Pro can be switched off under **Settings > Models**.

## Install

Download Elchi for macOS or Windows from [speech.patientdesk.ai/elchi](https://speech.patientdesk.ai/elchi). To build it yourself, follow [BUILD.md](BUILD.md); releases are made with `scripts/release/` (see the comments there).

Elchi updates itself from speech.patientdesk.ai. Updates are signed with Elchi's own key, and the app installs only bundles that carry that signature.

On first launch, Elchi asks for microphone access and, on macOS, Accessibility access so it can paste into other apps. Then choose a shortcut in Settings and start dictating.

## Usage

### Shortcut

The default shortcut can be changed in **Settings**. Elchi supports push-to-talk (hold) and toggle (tap) modes.

### Debug mode

Press `Cmd+Shift+D` on macOS or `Ctrl+Shift+D` on Windows and Linux in the settings window to show the **Debug** section. It has extra logging and some experimental options.

### Command-line flags

Elchi accepts command-line flags to control a running instance and to change startup behavior. These work on macOS, Windows, and Linux, and are still in beta.

Flags sent to an already running instance:

```bash
elchi --toggle-transcription    # Toggle recording on/off
elchi --toggle-post-process     # Toggle recording with post-processing on/off
elchi --cancel                  # Cancel the current operation
```

Startup flags:

```bash
elchi --start-hidden            # Start without showing the main window
elchi --no-tray                 # Start without the system tray icon
elchi --debug                   # Enable debug mode with verbose logging
elchi --help                    # Show all available flags
```

Flags can be combined, which is useful for autostart:

```bash
elchi --start-hidden --no-tray
```

On macOS, call the binary inside the app bundle:

```bash
/Applications/Elchi.app/Contents/MacOS/elchi --toggle-transcription
```

## Privacy

Recording and voice activity detection happen on your computer, and with Duyu-small so does transcription. Elchi has no analytics.

The network is used in these cases:

- **Model downloads.** A model is downloaded once, the first time you select it. After that it works offline.
- **Duyu Pro, during the 7-day trial and with Elchi Pro.** Each recording is sent to PatientDesk AI's Duyu API (`voice.patientdesk.ai`) to be transcribed. Switch off **Use Duyu Pro** under Settings > Models and no audio leaves your computer.
- **Smart formatting, on every plan, on by default.** The transcript text (never the audio) is sent to Elchi's formatter on the same servers (`voice.patientdesk.ai/v1/elchi/format`), which runs an open model we host ourselves: no third party sees it, and it is not stored. It comes back with fillers and self-corrections removed, spoken "new line" applied, lists and paragraphs laid out. If the formatter is slow or unreachable, the text is pasted as transcribed. Switch off **Smart formatting** under Settings > General and, with Duyu Pro off too, nothing leaves your computer.
- **Your plan.** A few times a day Elchi asks speech.patientdesk.ai which plan this computer has. It sends an install id (a one-way hash of the computer's id), the platform, the app version and the interface language.
- **Updates.** Elchi checks speech.patientdesk.ai for a newer version.
- **Post-processing, if you turn it on.** Post-processing is off by default. If you enable it and choose a remote provider, the transcript text is sent to that provider. A provider running on your own machine keeps it local.

Transcription history, including the recordings it keeps, is stored in Elchi's app data directory, listed under [Settings and data locations](#settings-and-data-locations).

## Settings and data locations

Elchi keeps its settings, history, logs, and downloaded models in its app data directory. The exact path is shown in **Settings > About**. The usual locations are:

- **macOS**: `~/Library/Application Support/com.elchi.app/`
- **Windows**: `C:\Users\{username}\AppData\Roaming\com.elchi.app\`
- **Linux**: `~/.local/share/com.elchi.app/`

## Known issues

### Bluetooth headset microphones (macOS)

Recording through a Bluetooth headset microphone on macOS can lower playback quality or volume while recording, because Bluetooth switches to a two-way audio profile. To avoid this, keep the headphones as the output device and select the built-in or another external microphone in Elchi.

### fn and Globe key shortcuts (macOS)

Shortcuts that include the `fn` (Globe) key only work on Apple keyboards: the built-in keyboard of a Mac or an Apple external keyboard. They will not trigger on third-party keyboards.

This is a hardware limitation. `fn` is not part of the standard USB keyboard specification. Apple reports it through a vendor-specific usage that macOS only honors from Apple devices, while third-party keyboards handle their `Fn` key in firmware and send nothing to the computer.

If you switch between a MacBook keyboard and an external one, use a shortcut made of standard modifiers (`ctrl`, `option`, `shift`, `command`) or a regular key.

## Troubleshooting

### Previous clipboard content is pasted instead of the transcription

If the transcription is correct in **History** but Elchi pastes something you copied earlier, the receiving app read the clipboard after Elchi had already restored your previous clipboard contents.

1. Open the settings window and press `Cmd+Shift+D` (macOS) or `Ctrl+Shift+D` (Windows/Linux) to show **Debug**.
2. On macOS and Windows, try **Reliable Paste (Beta)** with a clipboard paste method selected. It waits for the receiving app to read the clipboard before restoring it, instead of using a fixed delay. It is still experimental.
3. If Reliable Paste is off or unavailable, increase **Paste Delay (After)** and try again. This is the wait before your previous clipboard is restored. **Paste Delay (Before)** is the wait before the paste keystroke is sent and affects a different step.

### Installing models manually (proxies and restricted networks)

If Elchi cannot download models because of a proxy, firewall, or other network restriction, you can download them in a browser and install them by hand.

1. Find the app data directory (see [Settings and data locations](#settings-and-data-locations)) and create a `models` folder inside it if it does not exist:

   ```bash
   # macOS
   mkdir -p ~/Library/Application\ Support/com.elchi.app/models

   # Linux
   mkdir -p ~/.local/share/com.elchi.app/models
   ```

   ```powershell
   # Windows (PowerShell)
   New-Item -ItemType Directory -Force -Path "$env:APPDATA\com.elchi.app\models"
   ```

2. Download the model file from its Hugging Face page. For example, Parakeet Unified EN 0.6B (731 MB):
   `https://huggingface.co/handy-computer/parakeet-unified-en-0.6b-gguf/resolve/main/parakeet-unified-en-0.6b-Q8_0.gguf`
3. Place the `.gguf` file directly in the `models` folder. Do not rename it.
4. Restart Elchi and open **Settings > Models**. The model should show as downloaded.

Elchi also picks up models that are already in the shared Hugging Face cache (`~/.cache/huggingface/hub`), so a copy downloaded by another tool works without being moved.

### Custom Whisper models

Elchi discovers Whisper models in GGML `.bin` format placed in the `models` folder. This is useful for fine-tuned or community models that are not in the built-in list.

1. Get a Whisper model in GGML `.bin` format, for example from [Hugging Face](https://huggingface.co/models?search=whisper%20ggml).
2. Put the `.bin` file in the `models` folder.
3. Restart Elchi. The model appears under **Custom Models** in **Settings > Models**, named after its file (`my-custom-model.bin` becomes "My Custom Model").

We cannot help debug community models.

### Vulkan overlays and capture tools on Windows (`HANDY_KEEP_VULKAN_IMPLICIT_LAYERS`)

On Windows, Elchi tells the Vulkan loader to skip implicit layers, because overlay and screen-capture hooks can crash it. GPU acceleration stays on, and no system-wide setting is changed.

To opt out, for example for GPU selection or debugging tools, fully quit Elchi (including the tray icon) and run both commands in the same PowerShell window:

```powershell
$env:HANDY_KEEP_VULKAN_IMPLICIT_LAYERS = "1"
& "$env:ProgramFiles\Elchi\elchi.exe"
```

Adjust the path if you installed Elchi elsewhere. The override only applies to apps started from that PowerShell session. Elchi also keeps any existing `VK_LOADER_LAYERS_DISABLE` value.

## Linux notes

Elchi builds and runs on Linux, but macOS and Windows are our focus and Linux gets less testing. The notes below come from Handy and still apply.

### Text input tools

For reliable pasting on Linux, install the tool for your display server:

| Display server | Recommended tool | Install command                                    |
| -------------- | ---------------- | -------------------------------------------------- |
| X11            | `xdotool`        | `sudo apt install xdotool`                         |
| Wayland        | `wtype`          | `sudo apt install wtype`                           |
| Both           | `dotool`         | `sudo apt install dotool` (requires `input` group) |

- `dotool` requires adding your user to the `input` group: `sudo usermod -aG input $USER`, then log out and back in.
- On Ubuntu 26.04 with GNOME Wayland, `wtype` does not work. See [docs/troubleshooting/ubuntu-26-04-gnome-wayland](docs/troubleshooting/ubuntu-26-04-gnome-wayland/README.md) for a `ydotool` setup.

Without one of these tools, Elchi falls back to a built-in input method that works poorly on Wayland.

### Runtime library (`libgtk-layer-shell.so.0`)

Elchi links `gtk-layer-shell` for its recording overlay. If it fails to start with `error while loading shared libraries: libgtk-layer-shell.so.0`, or crashes or hangs before showing a window, install (or reinstall) the runtime package:

| Distro        | Package               | Command                                |
| ------------- | --------------------- | -------------------------------------- |
| Ubuntu/Debian | `libgtk-layer-shell0` | `sudo apt install libgtk-layer-shell0` |
| Fedora/RHEL   | `gtk-layer-shell`     | `sudo dnf install gtk-layer-shell`     |
| Arch Linux    | `gtk-layer-shell`     | `sudo pacman -S gtk-layer-shell`       |

To build from source on Ubuntu/Debian you also need `libgtk-layer-shell-dev`.

If the library is installed and startup still fails, you can skip `gtk-layer-shell` entirely. The overlay then falls back to a regular always-on-top window. This has helped on KDE Plasma under Wayland:

```bash
HANDY_NO_GTK_LAYER_SHELL=1 elchi
```

### WebKit DMA-BUF renderer (`WEBKIT_DISABLE_DMABUF_RENDERER`)

Elchi disables the WebKitGTK DMA-BUF renderer by default, because it can cause blank windows or crashes with some GPU drivers. An explicit value of `WEBKIT_DISABLE_DMABUF_RENDERER` is respected. If the recording overlay flickers or is partly drawn, try turning the renderer back on:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=0 elchi
```

If that brings back crashes, remove the override or set it to `1`. Fully quit Elchi, including the tray instance, before testing either value.

### Making an environment variable permanent

Set the variable in the environment of whatever launches Elchi. Shell profile exports may not apply to desktop-menu or autostart launches. In a `.desktop` file, prefix the `Exec=` line:

```ini
Exec=env HANDY_NO_GTK_LAYER_SHELL=1 elchi
```

Elchi's built-in autostart rewrites its own desktop entry, so editing that entry will not last. Disable the built-in autostart and manage your own startup entry instead.

### Recording overlay

The recording overlay is off by default on Linux (**Overlay Position: None**), because some compositors treat it as the active window, which makes the paste land in the wrong place. If you turn it on and pasting fails, set **Settings > Advanced > Overlay Position** back to **None**. **Audio Feedback** in the same section gives an audible cue instead.

If the overlay is empty or has a border on Hyprland or Omarchy, fully quit Elchi and start a [native installation](BUILD.md#linux-install-from-source) with Wayland enabled:

```bash
env -u HANDY_NO_GTK_LAYER_SHELL GDK_BACKEND=wayland elchi
```

If that works, set `GDK_BACKEND=wayland` only in Elchi's launcher.

### Global shortcuts on Wayland

On Wayland, global shortcuts have to be set up in your desktop environment or window manager, with an Elchi CLI flag as the command.

**GNOME:** In **Settings > Keyboard > Keyboard Shortcuts > Custom Shortcuts**, add a shortcut named `Toggle Elchi Transcription` with the command `elchi --toggle-transcription`, then assign a key combination such as `Super+O`.

**KDE Plasma:** In **System Settings > Shortcuts > Custom Shortcuts**, choose **Edit > New > Global Shortcut > Command/URL**, name it `Toggle Elchi Transcription`, set the key combination under **Trigger**, and set the command under **Action** to `elchi --toggle-transcription`.

**Sway / i3** (`~/.config/sway/config` or `~/.config/i3/config`):

```ini
bindsym $mod+o exec elchi --toggle-transcription
```

**Hyprland** (`~/.config/hypr/hyprland.conf`):

```ini
bind = $mainMod, O, exec, elchi --toggle-transcription
```

### Unix signals

Elchi can also be triggered with a signal, so a window manager or hotkey daemon can keep ownership of the key binding:

| Action                                    | Trigger                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| Toggle transcription                      | `pkill -USR2 -n elchi` or `elchi --toggle-transcription` |
| Toggle transcription with post-processing | `elchi --toggle-post-process`                            |

Example Sway config:

```ini
bindsym $mod+o exec pkill -USR2 -n elchi
bindsym $mod+p exec elchi --toggle-post-process
```

`pkill` only delivers the signal here. It does not stop the process.

Do not bind `SIGUSR1`. WebKitGTK, the web engine Elchi uses on Linux, uses `SIGUSR1` internally, and sending it can crash the app. Use `elchi --toggle-post-process` for the post-processing toggle.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and workflow, and [CONTRIBUTING_TRANSLATIONS.md](CONTRIBUTING_TRANSLATIONS.md) for translations. Bug reports and pull requests are welcome as issues and PRs in this repository.

## Based on Handy

Elchi is a fork of [Handy](https://github.com/cjpais/Handy) by CJ Pais and contributors, released under the MIT license. Most of the app — recording, shortcuts, pasting, the model manager, the settings UI, and the platform work behind all of it — is their work. We changed the default model to Duyu-small, focused on Turkish and English, and gave the app a new name and look. We are grateful to the Handy project for building something this solid and for making it free to fork.

Elchi is not affiliated with or endorsed by the Handy project. The Handy name and brand assets belong to their owners; Elchi uses its own name, icon, and visual identity.

Elchi also builds on:

- **Silero** for voice activity detection
- **ONNX Runtime** for Duyu-small, and **ggml** and **transcribe.cpp** for the other on-device models
- **Whisper** by OpenAI and the other open models available in the model picker
- **Tauri** for the app framework

## License

Elchi is released under the MIT license. See [LICENSE](LICENSE), which keeps the original Handy copyright notice alongside ours.

Duyu-small is released separately under the Apache-2.0 license. See its [model page](https://huggingface.co/KaanAydinli/Duyu-small).

## CI runner infrastructure

Portable Linux jobs run on Namespace. Ubuntu 24.04 jobs use
`namespace-profile-patientdesk`; version- or architecture-specific Linux builds
use explicit `nscloud` labels to retain their build environment. macOS, Windows,
and machine-local self-hosted jobs retain their specialized runners.
