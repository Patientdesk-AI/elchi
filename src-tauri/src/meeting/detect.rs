//! Noticing a call, as Granola does: when Zoom, Teams, a browser (Google Meet) or another
//! call app starts using the microphone and no meeting is being recorded, the pill's spot
//! asks whether to take notes; when the call app lets the microphone go during a meeting,
//! it asks whether to stop. Nothing starts or stops on its own: a muted call or a switched
//! headset looks the same from here.
//!
//! macOS 14 lists the processes that have audio open and whether each is recording
//! (`kAudioHardwarePropertyProcessObjectList`, `kAudioProcessPropertyIsRunningInput`), so
//! a thread looks every couple of seconds. Eshlik's own recording (dictation, a meeting)
//! is never counted.
#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use log::{info, warn};
use tauri::{AppHandle, Emitter};

use super::pill;
use crate::settings::get_settings;

const POLL: Duration = Duration::from_secs(2);
/// Polls in a row a call app must hold the microphone before Eshlik asks (4-6 s): opening
/// a call's settings or a browser's voice search should not.
const ON_POLLS: u32 = 3;
/// Polls in a row without the call app before asking whether the meeting is over (8-10 s):
/// switching headsets lets the microphone go for a moment.
const OFF_POLLS: u32 = 5;
/// An unanswered "take notes?" goes away after this, as "not now".
const ASK_FOR: Duration = Duration::from_secs(120);

/// Bundle identifiers (by prefix: a browser records from a helper process, such as
/// com.google.Chrome.helper) and the name the prompt gives them.
const CALL_APPS: &[(&str, &str)] = &[
    ("us.zoom.", "Zoom"),
    ("com.microsoft.teams", "Microsoft Teams"),
    ("com.apple.FaceTime", "FaceTime"),
    ("com.apple.avconferenced", "FaceTime"),
    ("com.tinyspeck.slackmacgap", "Slack"),
    ("com.cisco.webex", "Webex"),
    ("com.webex.", "Webex"),
    ("com.hnc.Discord", "Discord"),
    ("net.whatsapp.WhatsApp", "WhatsApp"),
    ("ru.keepcoder.Telegram", "Telegram"),
    ("org.telegram.", "Telegram"),
    ("com.google.Chrome", "Google Chrome"),
    ("com.microsoft.edgemac", "Microsoft Edge"),
    ("com.brave.Browser", "Brave"),
    ("company.thebrowser.", "Arc"),
    ("org.mozilla.firefox", "Firefox"),
    ("com.vivaldi.Vivaldi", "Vivaldi"),
    ("com.operasoftware.Opera", "Opera"),
    // Safari records in WebKit's GPU process.
    ("com.apple.Safari", "Safari"),
    ("com.apple.WebKit.GPU", "Safari"),
];

fn call_app(bundle: &str) -> Option<&'static str> {
    CALL_APPS
        .iter()
        .find(|(prefix, _)| bundle.starts_with(prefix))
        .map(|(_, name)| *name)
}

#[derive(Default)]
struct State {
    /// Call apps holding the microphone, and for how many polls in a row.
    present: HashMap<&'static str, u32>,
    /// The "take notes?" on screen: for which app, since when.
    asking: Option<(&'static str, Instant)>,
    /// Apps the user said "not now" to, until they let the microphone go.
    dismissed: HashSet<&'static str>,
    /// The meeting being recorded, the call apps seen during it, and for how many polls
    /// none of them has had the microphone.
    meeting: Option<i64>,
    call_apps: Vec<&'static str>,
    gone: u32,
    /// "Stop the notes?" is on screen, or was answered for this meeting.
    asking_stop: bool,
    answered_stop: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
/// "Take notes" was chosen before the recording disclosure was read: the meetings page
/// shows it, then starts.
static START_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Starts watching for calls. At startup, macOS only.
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("meeting-detect".into())
            .spawn(move || loop {
                std::thread::sleep(POLL);
                poll(&app);
            });
        if let Err(e) = spawned {
            warn!("Meetings: not watching for calls: {e}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[cfg(target_os = "macos")]
fn poll(app: &AppHandle) {
    let enabled = get_settings(app).meeting_detection;
    let users = if enabled { mic_users() } else { Vec::new() };
    let Ok(mut guard) = STATE.lock() else { return };
    let s = guard.get_or_insert_with(State::default);

    if !enabled {
        if s.asking.take().is_some() || s.asking_stop {
            pill::clear_prompt(app);
        }
        *s = State::default();
        return;
    }

    s.present.retain(|name, _| users.contains(name));
    for name in &users {
        *s.present.entry(*name).or_default() += 1;
    }
    let present = &s.present;
    s.dismissed.retain(|name| present.contains_key(name));
    let on: Vec<&'static str> = s
        .present
        .iter()
        .filter(|(_, polls)| **polls >= ON_POLLS)
        .map(|(name, _)| *name)
        .collect();

    match super::get_active_meeting() {
        Some(meeting) => {
            if s.asking.take().is_some() {
                pill::clear_prompt(app);
            }
            if s.meeting != Some(meeting.id) {
                s.meeting = Some(meeting.id);
                s.call_apps.clear();
                s.gone = 0;
                s.asking_stop = false;
                s.answered_stop = false;
            }
            for name in on {
                if !s.call_apps.contains(&name) {
                    s.call_apps.push(name);
                }
            }
            if s.call_apps.is_empty() || s.answered_stop {
                return;
            }
            if s.call_apps.iter().any(|name| s.present.contains_key(name)) {
                s.gone = 0;
                if s.asking_stop {
                    // The call is back (a headset switch, a rejoin).
                    s.asking_stop = false;
                    pill::clear_prompt(app);
                }
            } else {
                s.gone += 1;
                if s.gone >= OFF_POLLS && !s.asking_stop {
                    s.asking_stop = true;
                    info!("Meetings: {} let the microphone go", s.call_apps[0]);
                    pill::ask(app, pill::PromptKind::Stop, s.call_apps[0]);
                }
            }
        }
        None => {
            if s.meeting.take().is_some() {
                s.call_apps.clear();
                s.asking_stop = false;
                s.answered_stop = false;
                // The call app may still be on; the user ended the notes, not the call.
                s.dismissed.extend(on.iter().copied());
            }
            if let Some((name, since)) = s.asking {
                let timed_out = since.elapsed() >= ASK_FOR;
                if timed_out || !on.contains(&name) {
                    s.asking = None;
                    if timed_out {
                        s.dismissed.insert(name);
                    }
                    pill::clear_prompt(app);
                }
            } else if let Some(name) = on.iter().copied().find(|name| !s.dismissed.contains(name)) {
                info!("Meetings: {name} is using the microphone; asking to take notes");
                s.asking = Some((name, Instant::now()));
                pill::ask(app, pill::PromptKind::Start, name);
            }
        }
    }
}

/// The call apps that have the microphone open now, each once; never Eshlik itself.
#[cfg(target_os = "macos")]
fn mic_users() -> Vec<&'static str> {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};
    use objc2_core_audio::{
        kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyElementMain,
        kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioProcessPropertyBundleID,
        kAudioProcessPropertyIsRunningInput, kAudioProcessPropertyPID, AudioObjectGetPropertyData,
        AudioObjectGetPropertyDataSize, AudioObjectPropertyAddress,
    };
    use std::ffi::c_void;
    use std::ptr::NonNull;

    fn address(selector: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        }
    }
    /// One fixed-size property of an audio object.
    fn get<T: Copy + Default>(object: u32, selector: u32) -> Option<T> {
        let mut address = address(selector);
        let mut value = T::default();
        let mut size = std::mem::size_of::<T>() as u32;
        // SAFETY: `value` is a T and `size` says so; Core Audio writes at most that much.
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                NonNull::from(&mut address),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut value).cast::<c_void>(),
            )
        };
        (status == 0).then_some(value)
    }

    let system = kAudioObjectSystemObject as u32;
    let mut list = address(kAudioHardwarePropertyProcessObjectList);
    let mut size = 0u32;
    // SAFETY: plain out-parameters. (Before macOS 14 the property does not exist and the
    // call fails: no call is ever noticed there.)
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            system,
            NonNull::from(&mut list),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
        )
    };
    if status != 0 || size == 0 {
        return Vec::new();
    }
    let mut processes = vec![0u32; size as usize / std::mem::size_of::<u32>()];
    let Some(buffer) = NonNull::new(processes.as_mut_ptr()) else {
        return Vec::new();
    };
    // SAFETY: `processes` holds `size` bytes of object IDs.
    let status = unsafe {
        AudioObjectGetPropertyData(
            system,
            NonNull::from(&mut list),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            buffer.cast::<c_void>(),
        )
    };
    if status != 0 {
        return Vec::new();
    }
    processes.truncate(size as usize / std::mem::size_of::<u32>());

    let own = std::process::id() as i32;
    let mut names = Vec::new();
    for process in processes {
        if get::<u32>(process, kAudioProcessPropertyIsRunningInput) != Some(1)
            || get::<i32>(process, kAudioProcessPropertyPID) == Some(own)
        {
            continue;
        }
        let Some(bundle) = get::<usize>(process, kAudioProcessPropertyBundleID)
            .filter(|p| *p != 0)
            // SAFETY: the property hands over a CFString the caller releases.
            .map(|p| unsafe { CFString::wrap_under_create_rule(p as CFStringRef) }.to_string())
        else {
            continue;
        };
        if let Some(name) = call_app(&bundle) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    names
}

/// The prompt's "Take notes". The first meeting shows the recording disclosure first, in
/// Eshlik's window.
#[tauri::command]
#[specta::specta]
pub async fn meeting_prompt_start(app: AppHandle) -> Result<(), String> {
    // Answered for this call: closing the disclosure without starting does not ask again.
    if let Ok(mut guard) = STATE.lock() {
        if let Some(s) = guard.as_mut() {
            if let Some((name, _)) = s.asking.take() {
                s.dismissed.insert(name);
            }
        }
    }
    pill::clear_prompt(&app);
    if !get_settings(&app).meeting_consent_ack {
        START_REQUESTED.store(true, Ordering::SeqCst);
        crate::show_main_window(&app);
        let _ = app.emit("open-meetings", ());
        let _ = app.emit("meeting-start-requested", ());
        return Ok(());
    }
    super::start_meeting(app).await.map(|_| ())
}

/// The prompt's "Not now" (no notes for this call) or "Keep recording" (the meeting goes on).
#[tauri::command]
#[specta::specta]
pub fn meeting_prompt_dismiss(app: AppHandle) {
    if let Ok(mut guard) = STATE.lock() {
        if let Some(s) = guard.as_mut() {
            if let Some((name, _)) = s.asking.take() {
                s.dismissed.insert(name);
            }
            if s.asking_stop {
                s.asking_stop = false;
                s.answered_stop = true;
            }
        }
    }
    pill::clear_prompt(&app);
}

/// Whether the meetings page should start a meeting (after the disclosure) as it opens.
#[tauri::command]
#[specta::specta]
pub fn take_meeting_start_request() -> bool {
    START_REQUESTED.swap(false, Ordering::SeqCst)
}

#[cfg(test)]
mod tests {
    use super::call_app;

    #[test]
    fn call_apps_by_bundle_prefix() {
        assert_eq!(call_app("us.zoom.xos"), Some("Zoom"));
        assert_eq!(call_app("com.google.Chrome.helper"), Some("Google Chrome"));
        assert_eq!(call_app("com.microsoft.teams2"), Some("Microsoft Teams"));
        assert_eq!(call_app("com.granola.app.helper"), None);
        assert_eq!(call_app("com.apple.VoiceMemos"), None);
    }
}
