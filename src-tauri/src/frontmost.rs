//! The app a dictation went into: the frontmost application when it is saved, which
//! is the one Eshlik pastes into (its own overlay never takes focus). Shown on the
//! home feed ("Mail · 2 dk"). None when it cannot be told, on Linux, or when it is
//! Eshlik itself.

#[cfg(target_os = "macos")]
pub fn app_name() -> Option<String> {
    use objc2_app_kit::NSWorkspace;
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let name = app.localizedName()?.to_string();
    // Itself told by process, not by name: the name changed once (Elchi -> Eshlik),
    // and a dev build or an old bundle may still carry either.
    if name.is_empty() || app.processIdentifier() == std::process::id() as i32 {
        return None;
    }
    if let Some(bundle) = app.bundleURL().and_then(|u| u.path()) {
        icons::remember(&name, std::path::PathBuf::from(bundle.to_string()));
    }
    Some(name)
}

/// The icons of the apps dictations went into, for the home feed: a 64-pixel PNG
/// per app, made once from the app bundle's own icon with macOS's `sips` and kept
/// in the app data folder (app-icons/). Apps without an .icns file (a few that keep
/// their icon only in an asset catalog) keep the lettered badge.
#[cfg(target_os = "macos")]
mod icons {
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    static DIR: OnceLock<PathBuf> = OnceLock::new();
    static PENDING: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());

    pub fn init(dir: PathBuf) {
        let _ = DIR.set(dir);
    }

    pub fn file(name: &str) -> Option<PathBuf> {
        let safe: String = name
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { '_' })
            .collect();
        Some(DIR.get()?.join(format!("{safe}.png")))
    }

    /// Makes the app's icon if it is not there yet, off the calling thread.
    pub fn remember(name: &str, bundle: PathBuf) {
        let Some(out) = file(name) else { return };
        if out.exists() {
            return;
        }
        let mut pending = PENDING.lock().unwrap();
        if pending.iter().any(|(n, _)| n == name) {
            return;
        }
        pending.push((name.to_string(), bundle.clone()));
        let name = name.to_string();
        std::thread::spawn(move || {
            if let Err(e) = make(&bundle, &out) {
                log::debug!("No icon for {name}: {e}");
            }
            PENDING.lock().unwrap().retain(|(n, _)| n != &name);
        });
    }

    fn icns(bundle: &Path) -> Option<PathBuf> {
        let resources = bundle.join("Contents/Resources");
        let named = std::process::Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print :CFBundleIconFile"])
            .arg(bundle.join("Contents/Info.plist"))
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());
        let mut candidates = Vec::new();
        if let Some(n) = named {
            candidates.push(resources.join(if n.ends_with(".icns") {
                n
            } else {
                format!("{n}.icns")
            }));
        }
        candidates.push(resources.join("AppIcon.icns"));
        candidates.into_iter().find(|p| p.exists()).or_else(|| {
            std::fs::read_dir(&resources)
                .ok()?
                .flatten()
                .map(|e| e.path())
                .find(|p| p.extension().is_some_and(|x| x == "icns"))
        })
    }

    /// An app's icon by its name alone, for dictations saved before icons were kept:
    /// the app is looked for where apps are installed.
    pub fn find(name: &str) -> Option<PathBuf> {
        let out = file(name)?;
        if out.exists() {
            return Some(out);
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_default();
        let bundle = [
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications"),
            PathBuf::from("/System/Applications/Utilities"),
            home.join("Applications"),
        ]
        .into_iter()
        .map(|d| d.join(format!("{name}.app")))
        .find(|b| b.exists())?;
        make(&bundle, &out).ok()?;
        Some(out)
    }

    fn make(bundle: &Path, out: &Path) -> Result<(), String> {
        let icns = icns(bundle).ok_or("no .icns in the bundle")?;
        std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "png", "-Z", "64"])
            .arg(&icns)
            .arg("--out")
            .arg(out)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        status
            .success()
            .then_some(())
            .ok_or_else(|| "sips failed".into())
    }
}

/// Sets where app icons are kept (the app data folder). Called once at startup.
pub fn init(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    if let Ok(dir) = crate::portable::app_data_dir(app) {
        icons::init(dir.join("app-icons"));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The cached icons of these apps (PNG bytes), for the ones that have one.
#[tauri::command]
#[specta::specta]
pub fn get_app_icons(names: Vec<String>) -> std::collections::HashMap<String, Vec<u8>> {
    #[cfg(target_os = "macos")]
    {
        names
            .into_iter()
            .filter_map(|n| {
                let bytes = std::fs::read(icons::find(&n)?).ok()?;
                Some((n, bytes))
            })
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = names;
        std::collections::HashMap::new()
    }
}

#[cfg(target_os = "windows")]
pub fn app_name() -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    let exe = unsafe {
        let window = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(process);
        ok.ok()?;
        String::from_utf16_lossy(&buf[..len as usize])
    };
    windows_app_name(&exe)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn app_name() -> Option<String> {
    None
}

/// A readable name for a Windows executable path ("…\\slack.exe" -> "Slack").
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_app_name(path: &str) -> Option<String> {
    let stem = path
        .rsplit(['\\', '/'])
        .next()?
        .trim_end_matches(".exe")
        .trim_end_matches(".EXE");
    let known = match stem.to_lowercase().as_str() {
        "elchi" | "explorer" | "" => return None,
        "chrome" => "Chrome",
        "msedge" => "Edge",
        "firefox" => "Firefox",
        "winword" => "Word",
        "excel" => "Excel",
        "powerpnt" => "PowerPoint",
        "outlook" | "olk" => "Outlook",
        "ms-teams" | "teams" => "Teams",
        "code" => "VS Code",
        "windowsterminal" => "Terminal",
        "whatsapp" => "WhatsApp",
        "notepad" => "Notepad",
        _ => "",
    };
    if !known.is_empty() {
        return Some(known.to_string());
    }
    let mut chars = stem.chars();
    chars
        .next()
        .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
}

#[cfg(test)]
mod tests {
    use super::windows_app_name;

    #[test]
    fn windows_executables_get_readable_names() {
        assert_eq!(
            windows_app_name(r"C:\Program Files\Slack\slack.exe").as_deref(),
            Some("Slack")
        );
        assert_eq!(
            windows_app_name(r"C:\Program Files\Microsoft Office\WINWORD.EXE").as_deref(),
            Some("Word")
        );
        assert_eq!(
            windows_app_name(r"C:\Users\a\AppData\Local\Programs\cursor\Cursor.exe").as_deref(),
            Some("Cursor")
        );
        assert_eq!(windows_app_name(r"C:\Windows\explorer.exe"), None);
        assert_eq!(windows_app_name(r"C:\Program Files\Eshlik\elchi.exe"), None);
    }
}
