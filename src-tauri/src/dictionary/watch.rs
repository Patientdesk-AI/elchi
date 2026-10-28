//! Learning from corrections on macOS: after Elchi pastes a dictation, it watches the
//! text field it pasted into for a minute and a half (through Accessibility, which
//! Elchi already has to paste) and compares what it pasted with what that stretch of
//! text became. The correction becomes the dictation's text on the home feed, and a
//! fixed name becomes a dictionary entry (crate::dictionary::correct_dictation).
//!
//! The field is found through the frontmost app, not the system-wide element: for
//! Chromium and Electron apps (Chrome, Claude, Slack, Discord) the system-wide lookup
//! fails (kAXErrorCannotComplete), and those apps only expose their text once an
//! assistive app sets AXManualAccessibility on them, which this does.
//!
//! Only the pasted stretch is compared, and only while the text around it is
//! unchanged: if the user edits elsewhere or moves to another field, the watch ends
//! with what it last saw. Nothing read here leaves the computer. Fields that do not
//! expose their text (password fields, some custom editors) are simply not watched.

use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::string::CFString;
use tauri::AppHandle;

use crate::ax::{
    attribute, AXUIElementCreateApplication, AXUIElementCreateSystemWide, AXUIElementRef,
    AXUIElementSetAttributeValue, AXValueGetValue, AXValueRef, CFRange, K_AX_VALUE_CF_RANGE_TYPE,
};

/// How often to look, and for how long: often at first (a chat message is fixed and
/// sent within seconds), then now and then.
const FAST: Duration = Duration::from_millis(500);
const FAST_FOR: Duration = Duration::from_secs(20);
const SLOW: Duration = Duration::from_secs(2);
const WATCH_FOR: Duration = Duration::from_secs(90);
/// Longer fields are not watched (a whole document is not a dictation's context).
const MAX_FIELD_UTF16: usize = 200_000;

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// The focused text field of whatever app is in front.
struct Field(CFType);

// AXUIElement is a CF object that may be used from any thread.
unsafe impl Send for Field {}

impl Field {
    /// The focused element of the frontmost app (asking Electron and Chromium apps to
    /// expose their accessibility tree first), else of the system-wide element.
    fn focused() -> Option<Field> {
        use objc2_app_kit::NSWorkspace;
        let pid = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|a| a.processIdentifier());
        if let Some(pid) = pid {
            let app = unsafe {
                CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid) as CFTypeRef)
            };
            let flag = CFString::from_static_string("AXManualAccessibility");
            let yes = core_foundation::boolean::CFBoolean::true_value();
            unsafe {
                AXUIElementSetAttributeValue(
                    app.as_CFTypeRef() as AXUIElementRef,
                    flag.as_concrete_TypeRef(),
                    yes.as_CFTypeRef(),
                );
            }
            if let Some(f) = attribute(app.as_CFTypeRef() as AXUIElementRef, "AXFocusedUIElement") {
                return Some(Field(f));
            }
        }
        let system =
            unsafe { CFType::wrap_under_create_rule(AXUIElementCreateSystemWide() as CFTypeRef) };
        attribute(
            system.as_CFTypeRef() as AXUIElementRef,
            "AXFocusedUIElement",
        )
        .map(Field)
    }

    /// The field's text, with non-breaking spaces and carriage returns made plain (one
    /// unit for one, so offsets stay put): rich editors report those where Elchi
    /// pasted spaces and newlines.
    fn text(&self) -> Option<Vec<u16>> {
        let value = attribute(self.0.as_CFTypeRef() as AXUIElementRef, "AXValue")?;
        let s = value.downcast::<CFString>()?.to_string();
        let utf16: Vec<u16> = s
            .encode_utf16()
            .map(|u| match u {
                0x00a0 | 0x202f => 0x20,
                0x000d => 0x0a,
                _ => u,
            })
            .collect();
        (utf16.len() <= MAX_FIELD_UTF16).then_some(utf16)
    }

    /// Where the insertion point is, in UTF-16 units (the end of the selection).
    fn caret(&self) -> Option<usize> {
        let value = attribute(
            self.0.as_CFTypeRef() as AXUIElementRef,
            "AXSelectedTextRange",
        )?;
        let mut range = CFRange::default();
        let ok = unsafe {
            AXValueGetValue(
                value.as_CFTypeRef() as AXValueRef,
                K_AX_VALUE_CF_RANGE_TYPE,
                &mut range as *mut _ as *mut c_void,
            )
        };
        (ok && range.location >= 0).then(|| (range.location + range.length.max(0)) as usize)
    }
}

/// Where `pasted` sits in `field`: the occurrence ending at or just before the caret
/// (a trailing space may follow it), else the last one. UTF-16 offsets.
pub fn locate(field: &[u16], pasted: &[u16], caret: Option<usize>) -> Option<(usize, usize)> {
    if pasted.is_empty() || pasted.len() > field.len() {
        return None;
    }
    let ends: Vec<usize> = (pasted.len()..=field.len())
        .filter(|&end| field[end - pasted.len()..end] == *pasted)
        .collect();
    let end = match caret {
        Some(c) => ends
            .iter()
            .copied()
            .rev()
            .find(|&e| e <= c && c - e <= 2)
            .or_else(|| ends.last().copied()),
        None => ends.last().copied(),
    }?;
    Some((end - pasted.len(), end))
}

/// What the stretch `start..end` of `before` became in `after`, provided the text
/// before and after it is unchanged.
pub fn region_after(before: &[u16], start: usize, end: usize, after: &[u16]) -> Option<Vec<u16>> {
    let (prefix, suffix) = (&before[..start], &before[end..]);
    if after.len() < prefix.len() + suffix.len()
        || !after.starts_with(prefix)
        || !after.ends_with(suffix)
    {
        return None;
    }
    Some(after[prefix.len()..after.len() - suffix.len()].to_vec())
}

/// Watches the field `pasted` just went into (as dictation `history_id`), and
/// takes in whatever correction the user makes there.
pub fn start(app: &AppHandle, pasted: String, history_id: Option<i64>) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700)); // let the paste land
        let Some(field) = Field::focused() else {
            log::info!("Dictionary watch: no focused element to watch");
            return;
        };
        let Some(before) = field.text() else {
            log::info!("Dictionary watch: the focused element does not expose its text");
            return;
        };
        let pasted16: Vec<u16> = pasted.trim().encode_utf16().collect();
        let Some((start, end)) = locate(&before, &pasted16, field.caret()) else {
            log::info!(
                "Dictionary watch: the dictation is not in the focused field ({} units of text)",
                before.len()
            );
            return;
        };
        let began = std::time::Instant::now();
        let (mut last, mut looks, mut why) = (pasted16.clone(), 0, "time");
        while began.elapsed() < WATCH_FOR {
            std::thread::sleep(if began.elapsed() < FAST_FOR {
                FAST
            } else {
                SLOW
            });
            looks += 1;
            if GENERATION.load(Ordering::SeqCst) != generation {
                why = "a new dictation";
                break; // keep what this one became so far
            }
            let Some(now) = field.text() else {
                why = "the field went away";
                break;
            };
            match region_after(&before, start, end, &now) {
                Some(region) => last = region,
                None => {
                    // Sent (a chat box empties), or edited around it: keep the last good look.
                    why = "the text around it changed";
                    break;
                }
            }
        }
        let changed = last != pasted16;
        log::info!("Dictionary watch: {looks} looks, ended by {why}, corrected: {changed}");
        if changed {
            let edited = String::from_utf16_lossy(&last);
            super::correct_dictation(&app, history_id, &pasted, &edited);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn the_paste_is_found_at_the_caret() {
        let field = u("Merhaba. Raporu Kan'a gönder. Raporu Kan'a gönder. ");
        let pasted = u("Raporu Kan'a gönder.");
        let second = (30, 30 + pasted.len());
        assert_eq!(locate(&field, &pasted, Some(second.1 + 1)), Some(second)); // trailing space
        assert_eq!(
            locate(&field, &pasted, Some(29)),
            Some((9, 9 + pasted.len()))
        );
        assert_eq!(locate(&field, &pasted, None), Some(second));
        assert_eq!(locate(&field, &u("yok"), None), None);
    }

    #[test]
    fn an_edit_inside_the_paste_is_recovered() {
        let before = u("Selam! Raporu Kan'a gönder. Görüşürüz.");
        let start = 7;
        let end = start + u("Raporu Kan'a gönder.").len();
        let after = u("Selam! Raporu Kaan'a gönder. Görüşürüz.");
        assert_eq!(
            region_after(&before, start, end, &after),
            Some(u("Raporu Kaan'a gönder."))
        );
    }

    #[test]
    fn an_edit_outside_the_paste_ends_the_watch() {
        let before = u("Selam! Raporu Kan'a gönder.");
        let (start, end) = (7, before.len());
        assert_eq!(
            region_after(&before, start, end, &u("Merhaba! Raporu Kan'a gönder.")),
            None
        );
        assert_eq!(region_after(&before, start, end, &u("")), None);
    }

    #[test]
    fn turkish_text_is_measured_in_utf16() {
        let field = u("İyi günler. Şükrü’ye söyle.");
        let pasted = u("Şükrü’ye söyle.");
        let (s, e) = locate(&field, &pasted, None).unwrap();
        assert_eq!(String::from_utf16_lossy(&field[s..e]), "Şükrü’ye söyle.");
    }
}
