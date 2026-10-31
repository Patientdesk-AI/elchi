//! Whether there is anywhere to paste, on macOS: before pressing Cmd+V, Eshlik asks the
//! frontmost app (through Accessibility, which pasting already needs) what has focus.
//! When it is sure nothing that takes text does (the desktop, a Finder window, a list
//! or a button), the dictation is held for the overlay's Copy button instead of being
//! pasted into nothing.
//!
//! Being wrong that way blocks a paste that would have worked, which is worse than a
//! paste into nothing, so anything unclear pastes as before: an Accessibility error or
//! timeout, apps that report focus poorly (Chromium and Electron apps, terminals and
//! editors that draw their own text), and roles this does not know.

use std::time::{Duration, Instant};

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::string::CFString;
use log::info;

use crate::ax::{
    copy_attribute, is_settable, AXUIElementCreateApplication, AXUIElementRef,
    AXUIElementSetMessagingTimeout, K_AX_ERROR_NO_VALUE,
};

/// How long each Accessibility question may take before the answer counts as unknown.
const AX_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// Something that takes text has focus.
    Paste,
    /// Nothing that takes text has focus, for sure.
    NoField,
    /// Could not tell; paste as before.
    Unknown,
}

/// What the frontmost app said has focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus<'a> {
    /// It could not be asked (no permission, a timeout, an error).
    Failed,
    /// It answered that nothing has focus.
    Nothing,
    Element {
        role: &'a str,
        /// The element has a settable AXValue or an AXSelectedTextRange.
        editable: bool,
    },
}

/// What kind of app is in front.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum App {
    Finder,
    /// Chromium and Electron apps, Firefox, terminals and editors that draw their own
    /// text: what they report as focused does not say whether a paste would land.
    ReportsPoorly,
    Other,
}

/// Roles that take text.
const TEXT_ROLES: &[&str] = &[
    "AXTextField",
    "AXTextArea",
    "AXComboBox",
    "AXSearchField",
    "AXWebArea",
];

/// Roles that never take text, as reported by apps with a real accessibility tree.
const NON_TEXT_ROLES: &[&str] = &[
    "AXButton",
    "AXList",
    "AXOutline",
    "AXBrowser",
    "AXImage",
    "AXCheckBox",
    "AXRadioButton",
    "AXPopUpButton",
    "AXMenuButton",
    "AXSlider",
    "AXTabGroup",
    "AXToolbar",
];

/// Roles that take no text in Finder (its windows, lists and the desktop), but can
/// elsewhere: a spreadsheet's focused table or cell takes a paste, and an app that
/// draws its own text can report a window or group with a caret in it.
const FINDER_ROLES: &[&str] = &[
    "AXWindow",
    "AXGroup",
    "AXScrollArea",
    "AXSplitGroup",
    "AXTable",
    "AXRow",
    "AXCell",
    "AXColumn",
];

pub fn classify(focus: Focus, app: App) -> Target {
    let role = match focus {
        Focus::Failed => return Target::Unknown,
        Focus::Element { role, editable } if editable || TEXT_ROLES.contains(&role) => {
            return Target::Paste
        }
        _ if app == App::ReportsPoorly => return Target::Unknown,
        Focus::Nothing => return Target::NoField,
        Focus::Element { role, .. } => role,
    };
    if NON_TEXT_ROLES.contains(&role) || (app == App::Finder && FINDER_ROLES.contains(&role)) {
        Target::NoField
    } else {
        Target::Unknown
    }
}

/// Bundle identifiers (or their prefixes) of apps that report focus poorly and are not
/// recognisable by their frameworks: terminals and editors that draw their own text,
/// Java IDEs, and Firefox.
const POOR_REPORTERS: &[&str] = &[
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "com.github.wez.wezterm",
    "com.mitchellh.ghostty",
    "dev.warp.",
    "dev.zed.",
    "com.sublimetext.",
    "org.gnu.Emacs",
    "org.vim.MacVim",
    "com.jetbrains.",
    "com.google.android.studio",
    "org.mozilla.",
];

fn app_kind(bundle_id: &str, bundle_path: Option<&std::path::Path>) -> App {
    if bundle_id == "com.apple.finder" {
        return App::Finder;
    }
    if POOR_REPORTERS.iter().any(|p| bundle_id.starts_with(p)) || bundle_path.is_some_and(chromium)
    {
        return App::ReportsPoorly;
    }
    App::Other
}

/// Electron and Chromium apps ship "Electron Framework", "Chromium Embedded Framework"
/// or "<Browser> Framework" (Google Chrome, Brave Browser, Microsoft Edge...).
fn chromium(bundle: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(bundle.join("Contents/Frameworks")) else {
        return false;
    };
    entries.flatten().any(|e| {
        let name = e.file_name();
        let name = name.to_string_lossy();
        name.ends_with(" Framework.framework") || name.starts_with("Chromium")
    })
}

/// Where a paste into the frontmost app would land. Called on every dictation before
/// pasting, so each question has a short timeout.
pub fn check() -> Target {
    use objc2_app_kit::NSWorkspace;
    let started = Instant::now();
    let Some(front) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
        info!("Paste target: no frontmost app, pasting");
        return Target::Unknown;
    };
    let pid = front.processIdentifier();
    // Eshlik's own windows: asking itself from the main thread would wait on itself.
    if pid as u32 == std::process::id() {
        return Target::Unknown;
    }
    let bundle_id = front
        .bundleIdentifier()
        .map(|b| b.to_string())
        .unwrap_or_default();
    let bundle_path = front
        .bundleURL()
        .and_then(|u| u.path())
        .map(|p| std::path::PathBuf::from(p.to_string()));
    let app = app_kind(&bundle_id, bundle_path.as_deref());

    let element =
        unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid) as CFTypeRef) };
    let element_ref = element.as_CFTypeRef() as AXUIElementRef;
    unsafe { AXUIElementSetMessagingTimeout(element_ref, AX_TIMEOUT.as_secs_f32()) };
    let focused = copy_attribute(element_ref, "AXFocusedUIElement");
    let role;
    let focus = match &focused {
        Err(K_AX_ERROR_NO_VALUE) => Focus::Nothing,
        Err(_) => Focus::Failed,
        Ok(f) => {
            let f = f.as_CFTypeRef() as AXUIElementRef;
            unsafe { AXUIElementSetMessagingTimeout(f, AX_TIMEOUT.as_secs_f32()) };
            match copy_attribute(f, "AXRole")
                .ok()
                .and_then(|r| r.downcast::<CFString>())
            {
                Some(r) => {
                    role = r.to_string();
                    let editable = is_settable(f, "AXValue")
                        || copy_attribute(f, "AXSelectedTextRange").is_ok();
                    Focus::Element {
                        role: &role,
                        editable,
                    }
                }
                None => Focus::Failed,
            }
        }
    };
    let target = classify(focus, app);
    info!(
        "Paste target: {target:?} ({bundle_id}, {app:?}, {focus:?}) in {:?}",
        started.elapsed()
    );
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    fn element(role: &str, editable: bool) -> Focus<'_> {
        Focus::Element { role, editable }
    }

    #[test]
    fn text_fields_paste_in_any_app() {
        for app in [App::Finder, App::ReportsPoorly, App::Other] {
            for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXWebArea"] {
                assert_eq!(classify(element(role, false), app), Target::Paste);
            }
            // A custom editor with a settable value or a text selection.
            assert_eq!(classify(element("AXGroup", true), app), Target::Paste);
            assert_eq!(classify(element("AXUnknown", true), app), Target::Paste);
        }
    }

    #[test]
    fn nothing_focused_is_no_field() {
        assert_eq!(classify(Focus::Nothing, App::Other), Target::NoField);
        assert_eq!(classify(Focus::Nothing, App::Finder), Target::NoField);
    }

    #[test]
    fn non_text_roles_are_no_field() {
        for role in ["AXButton", "AXList", "AXOutline", "AXBrowser", "AXImage"] {
            assert_eq!(classify(element(role, false), App::Other), Target::NoField);
            assert_eq!(classify(element(role, false), App::Finder), Target::NoField);
        }
    }

    #[test]
    fn containers_and_tables_are_no_field_only_in_finder() {
        for role in ["AXWindow", "AXGroup", "AXScrollArea", "AXTable", "AXCell"] {
            assert_eq!(classify(element(role, false), App::Finder), Target::NoField);
            assert_eq!(classify(element(role, false), App::Other), Target::Unknown);
        }
    }

    #[test]
    fn unclear_answers_paste_as_before() {
        for app in [App::Finder, App::ReportsPoorly, App::Other] {
            assert_eq!(classify(Focus::Failed, app), Target::Unknown);
        }
        // Chromium, Electron and terminals: never sure there is no field.
        assert_eq!(
            classify(Focus::Nothing, App::ReportsPoorly),
            Target::Unknown
        );
        for role in ["AXButton", "AXList", "AXWindow", "AXGroup"] {
            assert_eq!(
                classify(element(role, false), App::ReportsPoorly),
                Target::Unknown
            );
        }
        // Roles this does not know, read-only text included.
        for role in ["AXStaticText", "AXUnknown", "AXLink", ""] {
            assert_eq!(classify(element(role, false), App::Other), Target::Unknown);
        }
    }

    #[test]
    fn apps_are_told_apart_by_bundle() {
        assert_eq!(app_kind("com.apple.finder", None), App::Finder);
        assert_eq!(app_kind("com.googlecode.iterm2", None), App::ReportsPoorly);
        assert_eq!(app_kind("dev.zed.Zed-Preview", None), App::ReportsPoorly);
        assert_eq!(app_kind("com.jetbrains.intellij", None), App::ReportsPoorly);
        assert_eq!(app_kind("com.apple.mail", None), App::Other);
        assert_eq!(app_kind("", None), App::Other);
    }

    #[test]
    fn chromium_apps_are_told_apart_by_their_frameworks() {
        let dir = std::env::temp_dir().join(format!("elchi-paste-target-{}", std::process::id()));
        let frameworks = dir.join("Slack.app/Contents/Frameworks");
        std::fs::create_dir_all(frameworks.join("Electron Framework.framework")).unwrap();
        let native = dir.join("Notes.app/Contents/Frameworks");
        std::fs::create_dir_all(native.join("Sparkle.framework")).unwrap();
        assert_eq!(
            app_kind("com.tinyspeck.slackmacgap", Some(&dir.join("Slack.app"))),
            App::ReportsPoorly
        );
        assert_eq!(
            app_kind("com.example.notes", Some(&dir.join("Notes.app"))),
            App::Other
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
