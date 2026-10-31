//! The meeting pill: while a meeting is recorded, a tiny floating pill at the right edge of
//! the screen (Eshlik's mark and both sides' levels), like Granola's. Hovering it opens the
//! live transcript beside it; clicking it brings Eshlik's window to the meeting. It never
//! takes focus, sits above full-screen apps, and is left out of screen sharing.
//!
//! Like the recording overlay, the panel is created once, hidden, when Eshlik starts, and
//! then only shown and hidden: made at the meeting's start, its page had not drawn yet and
//! the pill stayed invisible until Eshlik's window was brought up; and destroying an NSPanel
//! that tauri-nspanel made crashed Eshlik (an abort on the main thread as a meeting ended).
//!
//! The panel cannot reliably see the mouse itself (WebKit tracks hover only in the key
//! window, and a non-activating panel never is one), so a thread watches the cursor and
//! tells the pill when it is over it; the window grows to the left to make room for the
//! transcript and shrinks back when the cursor leaves.
//!
//! The same panel asks the questions detect.rs has when a call starts or ends: alone at
//! the pill's spot ("take notes?"), or beside the pill ("stop the notes?").

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const LABEL: &str = "meeting_pill";

/// The window is transparent and macOS clips whatever is drawn past its edge, so each
/// size leaves room around the pill, card or panel for their CSS shadows to fade out:
/// SIDE on the left and right (the stage's padding in MeetingPill.css, which also keeps
/// the pill off the screen's edge) and at least 30px above and below.
const SIDE: f64 = 16.0;
/// The pill itself (`.mp-pill`), at the window's right, vertically centred.
const PILL: (f64, f64) = (48.0, 88.0);
/// Logical sizes: the pill alone, and the pill with the transcript panel to its left.
const COLLAPSED: (f64, f64) = (PILL.0 + 2.0 * SIDE, 152.0);
const EXPANDED: (f64, f64) = (472.0, 604.0);
/// A question alone at the pill's spot, and one beside the pill.
const ASK: (f64, f64) = (392.0, 210.0);
const ASK_STOP: (f64, f64) = (452.0, 210.0);

static WATCHING: AtomicBool = AtomicBool::new(false);
/// A question is on screen; the transcript does not open on hover meanwhile.
static PROMPTING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptKind {
    /// A call started: take notes?
    Start,
    /// The call app let the microphone go during a meeting: stop the notes?
    Stop,
}

#[derive(Clone, Serialize)]
struct Prompt {
    kind: PromptKind,
    /// The call app, as the question names it ("Zoom").
    app: String,
}

#[cfg(target_os = "macos")]
tauri_nspanel::tauri_panel! {
    panel!(MeetingPillPanel {
        config: {
            can_become_key_window: false,
            is_floating_panel: true
        }
    })
}

/// Where the window goes for a size: flush with the screen's right edge (SIDE inside it
/// keeps the pill off the edge), centred on the same height either way, so the pill does
/// not move when the panel opens.
fn frame(app: &AppHandle, (w, h): (f64, f64)) -> Option<(f64, f64)> {
    let monitor = app.primary_monitor().ok()??;
    let scale = monitor.scale_factor();
    let (mx, my) = (
        monitor.position().x as f64 / scale,
        monitor.position().y as f64 / scale,
    );
    let (mw, mh) = (
        monitor.size().width as f64 / scale,
        monitor.size().height as f64 / scale,
    );
    Some((mx + mw - w, my + (mh - h) / 2.0))
}

fn place(app: &AppHandle, size: (f64, f64)) {
    let (Some(window), Some((x, y))) = (app.get_webview_window(LABEL), frame(app, size)) else {
        return;
    };
    let _ = window.set_size(tauri::LogicalSize::new(size.0, size.1));
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

/// Makes the pill, hidden, so its page is loaded by the first meeting. At startup, on the
/// main thread.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    create(app, false);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Shows the pill for the meeting that just started.
pub fn show(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || create(&handle, true));
        watch(app.clone());
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
fn create(app: &AppHandle, visible: bool) {
    use tauri_nspanel::{CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};
    if let Some(window) = app.get_webview_window(LABEL) {
        if !visible {
            return;
        }
        // Made for an earlier meeting: back on screen, closed, out of screen sharing.
        PROMPTING.store(false, Ordering::SeqCst);
        let _ = window.emit("meeting-pill-prompt", None::<Prompt>);
        place(app, COLLAPSED);
        let _ = window.show();
        super::hide_from_capture(&window, true);
        let _ = window.emit("meeting-pill-open", false);
        return;
    }
    let Some((x, y)) = frame(app, COLLAPSED) else {
        return;
    };
    match PanelBuilder::<_, MeetingPillPanel>::new(app, LABEL)
        .url(tauri::WebviewUrl::App("src/meeting-pill/index.html".into()))
        .title("Meeting")
        .position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
        .size(tauri::Size::Logical(tauri::LogicalSize {
            width: COLLAPSED.0,
            height: COLLAPSED.1,
        }))
        .level(PanelLevel::Status)
        .has_shadow(false)
        .transparent(true)
        .no_activate(true)
        .corner_radius(0.0)
        .style_mask(StyleMask::empty().borderless().nonactivating_panel())
        .with_window(|w| {
            w.decorations(false)
                .transparent(true)
                .focusable(false)
                .accept_first_mouse(true)
        })
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .full_screen_auxiliary(),
        )
        .build()
    {
        Ok(panel) => {
            if visible {
                panel.show();
            } else {
                panel.hide();
            }
            if let Some(window) = app.get_webview_window(LABEL) {
                super::hide_from_capture(&window, true);
            }
        }
        Err(e) => log::error!("Meeting pill not shown: {e}"),
    }
}

/// Takes the pill off screen when the meeting ends (hidden, not destroyed: see above).
pub fn hide(app: &AppHandle) {
    WATCHING.store(false, Ordering::SeqCst);
    PROMPTING.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.emit("meeting-pill-open", false);
        let _ = window.emit("meeting-pill-prompt", None::<Prompt>);
        let _ = window.hide();
    }
}

/// Puts a question on screen for `name`, the call app (see detect.rs).
pub fn ask(app: &AppHandle, kind: PromptKind, name: &str) {
    PROMPTING.store(true, Ordering::SeqCst);
    let handle = app.clone();
    let prompt = Prompt {
        kind,
        app: name.to_string(),
    };
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(LABEL) else {
            return;
        };
        let _ = window.emit("meeting-pill-open", false);
        let _ = window.emit("meeting-pill-prompt", Some(prompt));
        place(
            &handle,
            match kind {
                PromptKind::Start => ASK,
                PromptKind::Stop => ASK_STOP,
            },
        );
        let _ = window.show();
        // A call is on: someone may be sharing this screen.
        super::hide_from_capture(&window, true);
    });
}

/// Takes the question away: back to the pill during a meeting, off screen otherwise.
pub fn clear_prompt(app: &AppHandle) {
    if !PROMPTING.swap(false, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(LABEL) else {
            return;
        };
        let _ = window.emit("meeting-pill-prompt", None::<Prompt>);
        if super::is_recording() {
            place(&handle, COLLAPSED);
        } else {
            let _ = window.hide();
        }
    });
}

/// A window's frame in physical pixels: x, y, width, height.
type Frame = (f64, f64, f64, f64);

/// Whether a cursor (physical pixels) is anywhere in the window.
fn in_frame((x, y): (f64, f64), (wx, wy, ww, wh): Frame) -> bool {
    x >= wx && x < wx + ww && y >= wy && y < wy + wh
}

/// Whether a cursor (physical pixels) is over the pill itself: SIDE in from the window's
/// right edge, vertically centred. The transparent room around it for its shadow does not
/// count, so passing near the pill does not open the transcript.
fn on_pill((x, y): (f64, f64), (wx, wy, ww, wh): Frame, scale: f64) -> bool {
    let (side, pill_w, pill_h) = (SIDE * scale, PILL.0 * scale, PILL.1 * scale);
    x >= wx + ww - side - pill_w
        && x < wx + ww - side
        && y >= wy + (wh - pill_h) / 2.0
        && y < wy + (wh + pill_h) / 2.0
}

/// Opens the transcript while the cursor is over the pill, closes it once the cursor has
/// left the open window for a moment (so passing over the gap does not flicker it).
fn watch(app: AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut open = false;
        let mut outside = 0u32;
        while WATCHING.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(120));
            if PROMPTING.load(Ordering::SeqCst) {
                open = false;
                outside = 0;
                continue;
            }
            let Some(window) = app.get_webview_window(LABEL) else {
                continue;
            };
            let (Ok(cursor), Ok(pos), Ok(size)) = (
                app.cursor_position(),
                window.outer_position(),
                window.outer_size(),
            ) else {
                continue;
            };
            let scale = window.scale_factor().unwrap_or(1.0);
            let frame = (
                pos.x as f64,
                pos.y as f64,
                size.width as f64,
                size.height as f64,
            );
            let point = (cursor.x, cursor.y);
            let in_window = in_frame(point, frame);
            if !open && on_pill(point, frame, scale) {
                open = true;
                outside = 0;
                place(&app, EXPANDED);
                let _ = window.emit("meeting-pill-open", true);
            } else if open {
                outside = if in_window { 0 } else { outside + 1 };
                if outside >= 3 {
                    open = false;
                    let _ = window.emit("meeting-pill-open", false);
                    place(&app, COLLAPSED);
                }
            }
        }
    });
}

/// The pill was clicked: Eshlik's window, on the meeting.
#[tauri::command]
#[specta::specta]
pub fn open_meeting_from_pill(app: AppHandle) {
    crate::show_main_window(&app);
    let _ = app.emit("open-meetings", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A window of a logical size at a physical origin, as the watcher sees it.
    fn frame_of((w, h): (f64, f64), scale: f64) -> Frame {
        (1000.0, 400.0, w * scale, h * scale)
    }

    /// A point given in logical pixels from the window's top-left, in physical pixels.
    fn at(frame: Frame, scale: f64, (x, y): (f64, f64)) -> (f64, f64) {
        (frame.0 + x * scale, frame.1 + y * scale)
    }

    #[test]
    fn hover_opens_only_over_the_pill_itself() {
        for scale in [1.0, 2.0] {
            for size in [COLLAPSED, EXPANDED] {
                let frame = frame_of(size, scale);
                let (w, h) = size;
                let left = w - SIDE - PILL.0;
                let top = (h - PILL.1) / 2.0;
                let is = |x, y| on_pill(at(frame, scale, (x, y)), frame, scale);

                // Its centre and its top-left corner count; its far edges do not.
                assert!(
                    is(left + PILL.0 / 2.0, h / 2.0),
                    "{size:?} @{scale}x centre"
                );
                assert!(is(left, top), "{size:?} @{scale}x top-left corner");
                assert!(!is(left + PILL.0, h / 2.0), "{size:?} @{scale}x right edge");
                assert!(
                    !is(left + PILL.0 / 2.0, top + PILL.1),
                    "{size:?} @{scale}x bottom edge"
                );

                // The transparent room for the shadow does not open the transcript:
                // beside the pill toward the screen's edge, and above and below it.
                assert!(
                    !is(w - SIDE / 2.0, h / 2.0),
                    "{size:?} @{scale}x right margin"
                );
                assert!(
                    !is(left + PILL.0 / 2.0, top / 2.0),
                    "{size:?} @{scale}x above"
                );
                assert!(
                    !is(left + PILL.0 / 2.0, h - top / 2.0),
                    "{size:?} @{scale}x below"
                );
                assert!(!is(left - 1.0, h / 2.0), "{size:?} @{scale}x left of it");
            }
        }
    }

    #[test]
    fn the_window_counts_its_margin_as_inside() {
        // Keeping the transcript open while the cursor crosses the gap to the panel relies
        // on the whole window, margin included, counting as inside.
        for scale in [1.0, 2.0] {
            let frame = frame_of(EXPANDED, scale);
            assert!(in_frame(at(frame, scale, (1.0, 1.0)), frame));
            assert!(in_frame(
                at(frame, scale, (EXPANDED.0 - 1.0, EXPANDED.1 - 1.0)),
                frame
            ));
            assert!(!in_frame(at(frame, scale, (EXPANDED.0, 10.0)), frame));
            assert!(!in_frame(at(frame, scale, (-1.0, 10.0)), frame));
        }
    }

    /// The value of `property` in the first CSS rule for `selector`, in px.
    fn css_px(css: &str, selector: &str, property: &str) -> f64 {
        let rule = css
            .split(&format!("{selector} {{"))
            .nth(1)
            .and_then(|r| r.split('}').next())
            .unwrap_or_else(|| panic!("no rule for {selector}"));
        let value = rule
            .lines()
            .find_map(|l| l.trim().strip_prefix(&format!("{property}:")))
            .unwrap_or_else(|| panic!("no {property} in {selector}"));
        value
            .trim()
            .trim_end_matches(';')
            .split_whitespace()
            .last()
            .and_then(|v| v.strip_suffix("px"))
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| panic!("{selector} {property} is not in px: {value}"))
    }

    #[test]
    fn window_sizes_match_the_pill_css() {
        // The hover check and the window sizes assume the page's layout; a change on
        // either side must be made on both.
        let css = include_str!("../../../src/meeting-pill/MeetingPill.css");
        assert_eq!(css_px(css, ".mp-pill", "width"), PILL.0);
        assert_eq!(css_px(css, ".mp-pill", "height"), PILL.1);
        assert_eq!(css_px(css, ".mp-stage", "padding"), SIDE);
        let gap = css_px(css, ".mp-stage", "gap");
        let panel = css_px(css, ".mp-panel", "width");
        let card = css_px(css, ".mp-ask", "width");
        assert_eq!(COLLAPSED.0, SIDE + PILL.0 + SIDE);
        assert_eq!(EXPANDED.0, SIDE + panel + gap + PILL.0 + SIDE);
        assert_eq!(ASK.0, SIDE + card + SIDE);
        assert_eq!(ASK_STOP.0, SIDE + card + gap + PILL.0 + SIDE);
        // Room above and below the pill for its shadow.
        assert!((COLLAPSED.1 - PILL.1) / 2.0 >= 30.0);
    }
}
