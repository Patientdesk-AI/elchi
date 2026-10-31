//! Duyu Pro in Eshlik: the first 7 days after a machine first registers, and
//! for Eshlik Pro subscribers, recordings are transcribed by Duyu Pro (the
//! cloud model `duyu-1`); otherwise by Duyu-small on this computer.
//!
//! The entitlement lives on speech.patientdesk.ai. The app registers the
//! machine (a stable install id, so reinstalling does not restart the trial)
//! with `POST /api/elchi/session`, which answers with the plan and, while the
//! cloud is allowed, a short-lived token for the transcription API. Any cloud
//! failure falls back to Duyu-small, so dictation keeps working offline.
//!
//! Every install, on any plan, also gets a formatting token. Dictated text,
//! from either model, goes to Eshlik's formatter (an open model on our own
//! servers beside Duyu Pro) to be laid out as it would have been typed:
//! fillers and self-corrections gone, lists and paragraphs made. Formatting is
//! a setting, on by default; when it is off, slow or unreachable, the text is
//! pasted as transcribed.

use std::io::Cursor;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::settings::{get_settings, write_settings, SecretString};

pub const SITE_URL: &str = "https://speech.patientdesk.ai";
pub const API_URL: &str = "https://voice.patientdesk.ai/v1/audio/transcriptions";
pub const MODEL: &str = "duyu-1";
pub const FORMAT_URL: &str = "https://voice.patientdesk.ai/v1/elchi/format";
pub const NOTES_URL: &str = "https://voice.patientdesk.ai/v1/elchi/notes";
/// Live transcription, for meetings (src/meeting/stream.rs).
pub const STREAM_URL: &str = "wss://voice.patientdesk.ai/v1/audio/stream";
/// Writing a long meeting's notes takes a few model calls on the server.
const NOTES_TIMEOUT: Duration = Duration::from_secs(150);
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(30);
/// The server gives the formatter four seconds and then answers with the text
/// as sent; this covers that and the network, and no more.
const FORMAT_TIMEOUT: Duration = Duration::from_secs(6);
const SESSION_TIMEOUT: Duration = Duration::from_secs(15);
/// How often the plan is re-checked in the background.
const REFRESH_EVERY: Duration = Duration::from_secs(3 * 60 * 60);
/// After the upgrade page is opened, how often and how long to look for the
/// activation, so the app switches to Pro within seconds.
const WATCH_EVERY: Duration = Duration::from_secs(5);
const WATCH_FOR: Duration = Duration::from_secs(20 * 60);
/// Refresh the token when it has less than this left.
const TOKEN_MARGIN_S: i64 = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Trial,
    Pro,
    Free,
}

/// The server's answer, cached in settings so the app knows its plan offline.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct ElchiSession {
    pub plan: Plan,
    pub cloud: bool,
    pub trial_ends_at: Option<String>,
    pub pro_until: Option<String>,
    pub token: Option<SecretString>,
    pub token_expires_at: Option<String>,
    /// For the formatter alone, on every plan. Absent from sessions cached
    /// before formatting existed.
    #[serde(default)]
    pub format_token: Option<SecretString>,
    #[serde(default)]
    pub format_token_expires_at: Option<String>,
    pub upgrade_url: String,
    pub price_try_monthly: u32,
    pub free_months: u32,
}

/// What the interface shows: the session without the token.
#[derive(Clone, Debug, Serialize, Type)]
pub struct ElchiProStatus {
    /// None until the first successful check with the server.
    pub plan: Option<Plan>,
    /// Whether recordings go to Duyu Pro right now.
    pub cloud_active: bool,
    pub use_pro: bool,
    /// Whether dictated text is sent to the formatter.
    pub format: bool,
    pub trial_ends_at: Option<String>,
    pub pro_until: Option<String>,
    pub price_try_monthly: u32,
    pub free_months: u32,
}

#[derive(Debug)]
pub enum CloudError {
    /// The token was refused (expired or revoked): refresh the session.
    Unauthorized,
    /// The plan no longer covers Duyu Pro.
    NotEntitled,
    Other(anyhow::Error),
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudError::Unauthorized => f.write_str("Duyu Pro token refused"),
            CloudError::NotEntitled => f.write_str("Duyu Pro is not included in this plan"),
            CloudError::Other(e) => write!(f, "{e:#}"),
        }
    }
}

/// sha256 of the machine id: stable across reinstalls, reveals nothing.
pub fn install_id() -> Result<String> {
    let uid = machine_uid::get().map_err(|e| anyhow!("machine id unavailable: {e}"))?;
    let digest = Sha256::digest(format!("elchi-install:{}", uid.trim()).as_bytes());
    Ok(format!("{digest:x}"))
}

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn parse_time(s: &Option<String>) -> Option<DateTime<Utc>> {
    s.as_deref()
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
}

impl ElchiSession {
    /// A token that is still good for a while, if the plan includes the cloud.
    fn usable_token(&self, now: DateTime<Utc>) -> Option<String> {
        if !self.cloud {
            return None;
        }
        let token = self.token.as_ref().filter(|t| !t.0.is_empty())?;
        let expires = parse_time(&self.token_expires_at)?;
        ((expires - now).num_seconds() > TOKEN_MARGIN_S).then(|| token.0.clone())
    }

    /// The formatting token, if it is still good for a while. Any plan.
    fn usable_format_token(&self, now: DateTime<Utc>) -> Option<String> {
        let token = self.format_token.as_ref().filter(|t| !t.0.is_empty())?;
        let expires = parse_time(&self.format_token_expires_at)?;
        ((expires - now).num_seconds() > TOKEN_MARGIN_S).then(|| token.0.clone())
    }
}

#[derive(Serialize)]
struct SessionRequest<'a> {
    install_id: &'a str,
    platform: &'a str,
    app_version: &'a str,
    locale: &'a str,
}

async fn request_session(locale: String) -> Result<ElchiSession> {
    request_session_for(&install_id()?, locale).await
}

async fn request_session_for(id: &str, locale: String) -> Result<ElchiSession> {
    let body = SessionRequest {
        install_id: id,
        platform: platform(),
        app_version: env!("CARGO_PKG_VERSION"),
        locale: &locale,
    };
    let resp = reqwest::Client::builder()
        .timeout(SESSION_TIMEOUT)
        .build()?
        .post(format!("{SITE_URL}/api/elchi/session"))
        .json(&body)
        .send()
        .await
        .context("could not reach speech.patientdesk.ai")?;
    let status = resp.status();
    if !status.is_success() {
        bail!("Eshlik session request returned {status}");
    }
    resp.json::<ElchiSession>()
        .await
        .context("unexpected Eshlik session response")
}

pub struct ElchiPro {
    app: AppHandle,
    /// Serializes refreshes so a burst of callers makes one request.
    refresh_lock: Mutex<()>,
    watch_until: Mutex<Option<std::time::Instant>>,
}

impl ElchiPro {
    pub fn new(app: &AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app: app.clone(),
            refresh_lock: Mutex::new(()),
            watch_until: Mutex::new(None),
        })
    }

    /// Starts the background refresh: now, every few hours, and every few
    /// seconds while an upgrade is being watched for.
    pub fn start(self: &Arc<Self>) {
        let this = self.clone();
        std::thread::spawn(move || {
            let mut last = None::<std::time::Instant>;
            loop {
                let watching = this
                    .watch_until
                    .lock()
                    .unwrap()
                    .is_some_and(|until| std::time::Instant::now() < until);
                let due = last.is_none_or(|t| t.elapsed() >= REFRESH_EVERY);
                if due || watching {
                    if let Err(e) = this.refresh() {
                        debug!("Eshlik session refresh failed: {e:#}");
                    }
                    last = Some(std::time::Instant::now());
                }
                std::thread::sleep(WATCH_EVERY);
            }
        });
    }

    pub fn status(&self) -> ElchiProStatus {
        let settings = get_settings(&self.app);
        let session = settings.elchi_session.as_ref();
        ElchiProStatus {
            plan: session.map(|s| s.plan),
            cloud_active: settings.elchi_use_pro
                && session.is_some_and(|s| s.usable_token(Utc::now()).is_some()),
            use_pro: settings.elchi_use_pro,
            format: settings.elchi_format,
            trial_ends_at: session.and_then(|s| s.trial_ends_at.clone()),
            pro_until: session.and_then(|s| s.pro_until.clone()),
            price_try_monthly: session.map_or(200, |s| s.price_try_monthly),
            free_months: session.map_or(1, |s| s.free_months),
        }
    }

    /// Asks the server for the current plan and a fresh token, stores them
    /// and tells the interface. Blocking.
    pub fn refresh(&self) -> Result<ElchiSession> {
        let _guard = self.refresh_lock.lock().unwrap();
        let locale = get_settings(&self.app).app_language;
        let session =
            std::thread::spawn(move || tauri::async_runtime::block_on(request_session(locale)))
                .join()
                .map_err(|_| anyhow!("Eshlik session thread panicked"))??;

        let mut settings = get_settings(&self.app);
        let before = settings.elchi_session.as_ref().map(|s| s.plan);
        settings.elchi_session = Some(session.clone());
        write_settings(&self.app, settings);

        if before != Some(session.plan) {
            info!("Eshlik plan: {:?} -> {:?}", before, session.plan);
            if session.plan == Plan::Pro {
                *self.watch_until.lock().unwrap() = None;
            }
            if before.is_some_and(|p| p != Plan::Free) && session.plan == Plan::Free {
                self.on_trial_ended();
            }
        }
        let _ = self.app.emit("elchi-pro-changed", self.status());
        Ok(session)
    }

    /// Whether recordings can go to Duyu Pro, from the cached plan (no
    /// network): decides if dictation may start before Duyu-small is ready.
    pub fn cloud_ready(&self) -> bool {
        let settings = get_settings(&self.app);
        settings.elchi_use_pro && settings.elchi_session.as_ref().is_some_and(|s| s.cloud)
    }

    /// The token to send to Duyu Pro, refreshing it if it is about to expire.
    /// None when Duyu Pro is off, not in the plan, or unreachable.
    pub fn cloud_token(&self) -> Option<String> {
        let settings = get_settings(&self.app);
        if !settings.elchi_use_pro {
            return None;
        }
        let now = Utc::now();
        if let Some(token) = settings
            .elchi_session
            .as_ref()
            .and_then(|s| s.usable_token(now))
        {
            return Some(token);
        }
        // Only worth a round trip if the plan may include the cloud.
        if settings.elchi_session.as_ref().is_some_and(|s| !s.cloud) {
            return None;
        }
        self.refresh().ok().and_then(|s| s.usable_token(Utc::now()))
    }

    /// The token for the formatter, when formatting is on. Never waits on the
    /// network: dictation is not held up for a session request. A stale token
    /// (the app was asleep past its twelve hours) starts a refresh in the
    /// background, and this one dictation goes out unformatted.
    pub fn format_token(self: &Arc<Self>) -> Option<String> {
        let settings = get_settings(&self.app);
        if !settings.elchi_format {
            return None;
        }
        let token = settings
            .elchi_session
            .as_ref()
            .and_then(|s| s.usable_format_token(Utc::now()));
        if token.is_none() {
            let this = self.clone();
            std::thread::spawn(move || {
                if let Err(e) = this.refresh() {
                    debug!("Eshlik session refresh for formatting failed: {e:#}");
                }
            });
        }
        token
    }

    /// A token that stands for this install on any plan (the Duyu Pro one, else the
    /// formatting one), refreshing if neither is current: for stopping a meeting shared
    /// while the plan included Duyu Pro. Blocking.
    pub fn install_token(&self) -> Option<String> {
        let usable = |s: &ElchiSession| {
            let now = Utc::now();
            s.usable_token(now).or_else(|| s.usable_format_token(now))
        };
        if let Some(token) = get_settings(&self.app)
            .elchi_session
            .as_ref()
            .and_then(usable)
        {
            return Some(token);
        }
        self.refresh().ok().as_ref().and_then(usable)
    }

    /// Opens the upgrade page and watches for the activation.
    pub fn open_upgrade(&self) -> Result<()> {
        let url = match get_settings(&self.app).elchi_session {
            Some(s) => s.upgrade_url,
            None => self.refresh()?.upgrade_url,
        };
        if !url.starts_with(&format!("{SITE_URL}/")) {
            bail!("unexpected upgrade URL");
        }
        use tauri_plugin_opener::OpenerExt;
        self.app
            .opener()
            .open_url(&url, None::<&str>)
            .map_err(|e| anyhow!("could not open the browser: {e}"))?;
        *self.watch_until.lock().unwrap() = Some(std::time::Instant::now() + WATCH_FOR);
        Ok(())
    }

    /// Called when a transcription learns the plan no longer covers Duyu Pro.
    pub fn mark_not_entitled(&self) {
        if let Err(e) = self.refresh() {
            warn!("Eshlik session refresh after a refused request failed: {e:#}");
        }
    }

    /// The trial (or subscription) just ended: bring the main window up once
    /// so the upgrade banner is seen.
    fn on_trial_ended(&self) {
        let mut settings = get_settings(&self.app);
        if settings.elchi_trial_end_seen {
            return;
        }
        settings.elchi_trial_end_seen = true;
        write_settings(&self.app, settings);
        crate::show_main_window(&self.app);
        let _ = self.app.emit("elchi-trial-ended", ());
    }
}

fn wav_bytes(audio: &[f32], sample_rate: u32) -> Result<Vec<u8>> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf = Cursor::new(Vec::with_capacity(audio.len() * 2 + 44));
    {
        let mut w = hound::WavWriter::new(&mut buf, spec)?;
        for &s in audio {
            w.write_sample((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)?;
        }
        w.finalize()?;
    }
    Ok(buf.into_inner())
}

#[derive(Deserialize)]
struct TranscriptionResponse {
    text: String,
}

async fn request_transcription(
    token: String,
    wav: Vec<u8>,
    language: Option<String>,
) -> Result<String, CloudError> {
    let file = reqwest::multipart::Part::bytes(wav)
        .file_name("elchi.wav")
        .mime_str("audio/wav")
        .map_err(|e| CloudError::Other(e.into()))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", file)
        .text("model", MODEL)
        .text("response_format", "json");
    if let Some(lang) = language {
        form = form.text("language", lang);
    }
    let client = reqwest::Client::builder()
        .timeout(TRANSCRIBE_TIMEOUT)
        .build()
        .map_err(|e| CloudError::Other(e.into()))?;
    let resp = client
        .post(API_URL)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| CloudError::Other(anyhow!(e).context("could not reach the Duyu API")))?;
    match resp.status().as_u16() {
        200..=299 => resp
            .json::<TranscriptionResponse>()
            .await
            .map(|r| r.text.trim().to_string())
            .map_err(|e| CloudError::Other(anyhow!(e).context("unexpected Duyu API response"))),
        401 => Err(CloudError::Unauthorized),
        402 | 403 => Err(CloudError::NotEntitled),
        status => Err(CloudError::Other(anyhow!("the Duyu API returned {status}"))),
    }
}

#[derive(Serialize)]
struct FormatRequest<'a> {
    text: &'a str,
    /// The personal dictionary (crate::dictionary): spellings to use where a word
    /// in the dictation is one of their misheard forms and the context fits.
    vocabulary: &'a [crate::dictionary::DictionaryWord],
}

#[derive(Deserialize)]
struct FormatResponse {
    text: String,
    formatted: bool,
}

/// Dictated text laid out by Eshlik's formatter, or None when it could not be
/// (the caller pastes the text as transcribed).
pub async fn format(
    token: &str,
    text: &str,
    vocabulary: &[crate::dictionary::DictionaryWord],
) -> Option<String> {
    let started = std::time::Instant::now();
    let resp = reqwest::Client::builder()
        .timeout(FORMAT_TIMEOUT)
        .build()
        .ok()?
        .post(FORMAT_URL)
        .bearer_auth(token)
        .json(&FormatRequest { text, vocabulary })
        .send()
        .await;
    let out = match resp {
        Ok(r) if r.status().is_success() => r.json::<FormatResponse>().await.ok(),
        Ok(r) => {
            warn!("Eshlik formatter returned {}", r.status());
            None
        }
        Err(e) => {
            warn!("Eshlik formatter unreachable: {e}");
            None
        }
    };
    debug!(
        "Eshlik formatter: {:?} in {:?}",
        out.as_ref().map(|r| r.formatted),
        started.elapsed()
    );
    out.filter(|r| r.formatted && !r.text.trim().is_empty())
        .map(|r| r.text)
}

#[derive(Serialize)]
pub struct NotesSegment<'a> {
    pub speaker: &'a str,
    /// When it was said, from the meeting's start.
    pub start_ms: i64,
    pub text: &'a str,
}

#[derive(Serialize)]
struct NotesRequest<'a> {
    segments: &'a [NotesSegment<'a>],
    user_notes: &'a str,
    language: &'a str,
}

#[derive(Deserialize)]
pub struct MeetingNotes {
    pub title: String,
    pub notes: String,
}

/// A meeting's notes from its transcript and the user's own notes (Duyu Pro only).
pub async fn meeting_notes(
    token: &str,
    segments: &[NotesSegment<'_>],
    user_notes: &str,
    language: &str,
) -> Result<MeetingNotes, CloudError> {
    let resp = reqwest::Client::builder()
        .timeout(NOTES_TIMEOUT)
        .build()
        .map_err(|e| CloudError::Other(e.into()))?
        .post(NOTES_URL)
        .bearer_auth(token)
        .json(&NotesRequest {
            segments,
            user_notes,
            language,
        })
        .send()
        .await
        .map_err(|e| CloudError::Other(anyhow!("meeting notes unreachable: {e}")))?;
    match resp.status().as_u16() {
        200 => resp
            .json::<MeetingNotes>()
            .await
            .map_err(|e| CloudError::Other(anyhow!("meeting notes: bad response: {e}"))),
        401 => Err(CloudError::Unauthorized),
        402 | 403 => Err(CloudError::NotEntitled),
        status => Err(CloudError::Other(anyhow!(
            "meeting notes returned {status}"
        ))),
    }
}

/// Transcribes 16 kHz mono audio with Duyu Pro. `language` is a hint
/// (`tr` / `en`); None lets the model decide. Blocking; safe to call from
/// inside or outside an async runtime.
pub fn transcribe(
    token: &str,
    audio: &[f32],
    language: Option<&str>,
) -> Result<String, CloudError> {
    let wav = wav_bytes(audio, 16_000).map_err(CloudError::Other)?;
    let token = token.to_string();
    let language = language.map(str::to_string);
    std::thread::spawn(move || {
        tauri::async_runtime::block_on(request_transcription(token, wav, language))
    })
    .join()
    .map_err(|_| CloudError::Other(anyhow!("Duyu API request thread panicked")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(cloud: bool, token: Option<&str>, expires_in_s: i64) -> ElchiSession {
        ElchiSession {
            plan: if cloud { Plan::Trial } else { Plan::Free },
            cloud,
            trial_ends_at: None,
            pro_until: None,
            token: token.map(|t| SecretString(t.to_string())),
            format_token: Some(SecretString("f".into())),
            format_token_expires_at: Some((Utc::now() + chrono::Duration::hours(12)).to_rfc3339()),
            token_expires_at: Some(
                (Utc::now() + chrono::Duration::seconds(expires_in_s)).to_rfc3339(),
            ),
            upgrade_url: format!("{SITE_URL}/elchi/activate?code=x"),
            price_try_monthly: 200,
            free_months: 1,
        }
    }

    #[test]
    fn token_used_only_while_cloud_and_fresh() {
        let now = Utc::now();
        assert_eq!(
            session(true, Some("t"), 3600).usable_token(now).as_deref(),
            Some("t")
        );
        assert!(session(true, Some("t"), 30).usable_token(now).is_none()); // about to expire
        assert!(session(false, Some("t"), 3600).usable_token(now).is_none());
        assert!(session(true, None, 3600).usable_token(now).is_none());
        assert!(session(true, Some(""), 3600).usable_token(now).is_none());
    }

    #[test]
    fn session_response_parses() {
        let json = r#"{"plan":"trial","cloud":true,"trial_ends_at":"2026-10-20T10:00:00Z",
            "pro_until":null,"token":"abc","token_expires_at":"2026-10-13T22:00:00Z",
            "upgrade_url":"https://speech.patientdesk.ai/elchi/activate?code=x",
            "price_try_monthly":200,"free_months":1}"#;
        let s: ElchiSession = serde_json::from_str(json).unwrap();
        assert_eq!(s.plan, Plan::Trial);
        assert!(
            s.format_token.is_none(),
            "a session cached before formatting"
        );
        assert_eq!(s.token.unwrap().0, "abc");
    }

    #[test]
    fn format_token_on_every_plan_while_fresh() {
        let now = Utc::now();
        let mut free = session(false, None, 0);
        assert_eq!(free.usable_format_token(now).as_deref(), Some("f"));
        free.format_token_expires_at = Some((now + chrono::Duration::seconds(30)).to_rfc3339());
        assert!(free.usable_format_token(now).is_none()); // about to expire
        free.format_token = None;
        assert!(free.usable_format_token(now).is_none());
    }

    #[test]
    fn install_id_is_stable_hex() {
        let a = install_id().unwrap();
        assert_eq!(a, install_id().unwrap());
        assert_eq!(a.len(), 64);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    /// Against the live site and API, with a throwaway install id:
    /// `cargo test --lib elchi_pro::tests::live -- --ignored --nocapture`.
    /// Prints the install id so the row can be deleted afterwards.
    #[test]
    #[ignore = "talks to speech.patientdesk.ai and voice.patientdesk.ai"]
    fn live_trial_session_transcribes() {
        let id = format!(
            "{:x}",
            Sha256::digest(format!(
                "elchi-live-test-{}",
                Utc::now().timestamp_nanos_opt().unwrap()
            ))
        );
        println!("test install id: {id}");
        let session =
            tauri::async_runtime::block_on(request_session_for(&id, "tr".into())).unwrap();
        assert_eq!(session.plan, Plan::Trial);
        let token = session.usable_token(Utc::now()).expect("trial token");
        assert!(session
            .upgrade_url
            .starts_with(&format!("{SITE_URL}/elchi/activate?code=")));

        let clips = std::env::var("DUYU_TEST_CLIPS").expect("DUYU_TEST_CLIPS");
        let mut r = hound::WavReader::open(format!("{clips}/tr1.wav")).unwrap();
        let audio: Vec<f32> = r
            .samples::<i16>()
            .map(|s| s.unwrap() as f32 / 32768.0)
            .collect();
        let text = transcribe(&token, &audio, None).unwrap();
        println!("Duyu Pro: {text}");
        assert!(text.to_lowercase().contains("toplantı"));
        assert!(matches!(
            transcribe("not-a-token", &audio, None),
            Err(CloudError::Unauthorized)
        ));

        let fmt = session
            .usable_format_token(Utc::now())
            .expect("format token");
        let raw = "Iıı şey, toplantıyı saat üçe alalım, yok yok dörde alalım.";
        let formatted = tauri::async_runtime::block_on(format(&fmt, raw, &[]));
        println!("formatted: {formatted:?}");
        let formatted = formatted.expect("formatted");
        assert!(formatted.contains("dör") && !formatted.contains("üçe"));
        assert!(tauri::async_runtime::block_on(format("not-a-token", raw, &[])).is_none());
    }

    #[test]
    fn wav_has_header_and_samples() {
        let w = wav_bytes(&[0.0, 0.5, -1.0, 2.0], 16_000).unwrap();
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(w.len(), 44 + 4 * 2);
    }
}
