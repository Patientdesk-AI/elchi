//! Sharing a finished meeting by link (https://elchi.xyz/<id>): a snapshot of its notes,
//! and its transcript and recording when the user picks them, kept on PatientDesk's
//! servers until the user stops sharing. Whoever has the link can read, listen and
//! download. The website's /api/elchi/shares makes the link (Duyu Pro token: the trial
//! and Eshlik Pro only) and hands back a signed URL the recording goes straight to; once
//! it is all there, the link starts to work. Stopping takes any plan's token.
//!
//! The recording goes up as Opus in WebM, which Chrome, Firefox and Safari play in an
//! audio element: about 12 MB an hour, where the WAV the meeting keeps is 115 MB.

use std::io::{Seek, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::anyhow;
use serde::{Deserialize, Serialize};

use super::webm;
use crate::elchi_pro::{CloudError, SITE_URL};

const SHARES_URL: &str = "https://speech.patientdesk.ai/api/elchi/shares";
/// What the server is told the recording is: it names the file `<id>.webm`.
pub const AUDIO_FORMAT: &str = "webm";
const AUDIO_MIME: &str = "audio/webm";
/// Clear speech at 16 kHz, with room to spare: about 12 MB an hour with the container's
/// share.
const BITRATE: i32 = 24_000;
/// Longer recordings are not shared (about 140 MB at `BITRATE`).
pub const MAX_RECORDING: Duration = Duration::from_secs(12 * 3600);
/// The bucket's limit on the server, past what `MAX_RECORDING` should come to.
pub const MAX_AUDIO_BYTES: u64 = 200 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize)]
pub struct ShareSegment<'a> {
    pub speaker: &'a str,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: &'a str,
}

#[derive(Serialize)]
pub struct ShareRequest<'a> {
    pub title: &'a str,
    pub notes: &'a str,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub segments: Option<Vec<ShareSegment<'a>>>,
    pub audio_bytes: Option<u64>,
    pub audio_format: Option<&'a str>,
}

#[derive(Deserialize)]
pub struct CreatedShare {
    pub id: String,
    pub url: String,
    pub upload_url: Option<String>,
}

fn client(timeout: Option<Duration>) -> Result<reqwest::Client, CloudError> {
    let mut builder = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT);
    if let Some(t) = timeout {
        builder = builder.timeout(t);
    }
    builder.build().map_err(|e| CloudError::Other(e.into()))
}

async fn status_of(what: &str, resp: reqwest::Response) -> Result<reqwest::Response, CloudError> {
    match resp.status().as_u16() {
        200..=299 => Ok(resp),
        401 => Err(CloudError::Unauthorized),
        402 | 403 => Err(CloudError::NotEntitled),
        status => {
            let body = resp.text().await.unwrap_or_default();
            Err(CloudError::Other(anyhow!(
                "{what} returned {status}: {body}"
            )))
        }
    }
}

/// Makes the link. With a recording to come, it works only after `finish`.
pub async fn create(token: &str, req: &ShareRequest<'_>) -> Result<CreatedShare, CloudError> {
    let resp = client(Some(REQUEST_TIMEOUT))?
        .post(SHARES_URL)
        .bearer_auth(token)
        .json(req)
        .send()
        .await
        .map_err(|e| CloudError::Other(anyhow!("sharing unreachable: {e}")))?;
    let created: CreatedShare = status_of("sharing", resp)
        .await?
        .json()
        .await
        .map_err(|e| CloudError::Other(anyhow!("sharing: bad response: {e}")))?;
    if !is_share_url(&created.url) {
        return Err(CloudError::Other(anyhow!("sharing: unexpected link")));
    }
    Ok(created)
}

/// Puts the recording `mix` made where the server said: no time limit, since a long
/// meeting on a slow connection takes a while.
pub async fn upload(upload_url: &str, recording: &Path) -> Result<(), CloudError> {
    if !upload_url.starts_with("https://") {
        return Err(CloudError::Other(anyhow!("sharing: unexpected upload URL")));
    }
    let file = tokio::fs::File::open(recording)
        .await
        .map_err(|e| CloudError::Other(e.into()))?;
    let len = file
        .metadata()
        .await
        .map_err(|e| CloudError::Other(e.into()))?
        .len();
    let resp = client(None)?
        .put(upload_url)
        .header(reqwest::header::CONTENT_TYPE, AUDIO_MIME)
        .header(reqwest::header::CONTENT_LENGTH, len)
        .body(reqwest::Body::from(file))
        .send()
        .await
        .map_err(|e| CloudError::Other(anyhow!("recording upload failed: {e}")))?;
    status_of("recording upload", resp).await.map(|_| ())
}

/// The recording is up: the link starts to work.
pub async fn finish(token: &str, id: &str) -> Result<(), CloudError> {
    let resp = client(Some(REQUEST_TIMEOUT))?
        .post(format!("{SHARES_URL}/{id}/ready"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| CloudError::Other(anyhow!("sharing unreachable: {e}")))?;
    status_of("sharing", resp).await.map(|_| ())
}

/// Stops sharing: the link stops working and the server deletes its copy.
pub async fn revoke(token: &str, id: &str) -> Result<(), CloudError> {
    let resp = client(Some(REQUEST_TIMEOUT))?
        .delete(format!("{SHARES_URL}/{id}"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| CloudError::Other(anyhow!("sharing unreachable: {e}")))?;
    // Gone already (404) is what stopping wants.
    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    status_of("stop sharing", resp).await.map(|_| ())
}

/// How long the mixed recording the two kept tracks make is, without making it.
pub fn mixed_length(tracks: &[PathBuf]) -> Option<Duration> {
    tracks
        .iter()
        .filter_map(|p| hound::WavReader::open(p).ok())
        .map(|r| Duration::from_secs_f64(r.duration() as f64 / r.spec().sample_rate as f64))
        .max()
        .filter(|d| !d.is_zero())
}

/// One file to listen to: the user's microphone and the call's audio mixed into one
/// 16 kHz mono track and encoded as Opus in WebM.
pub fn mix(tracks: &[PathBuf], out: &Path) -> anyhow::Result<()> {
    let mut readers = tracks
        .iter()
        .map(hound::WavReader::open)
        .collect::<Result<Vec<_>, _>>()?;
    let spec = readers
        .first()
        .map(|r| r.spec())
        .ok_or_else(|| anyhow!("no recording to share"))?;
    if spec.channels != 1 || readers.iter().any(|r| r.spec() != spec) {
        return Err(anyhow!("unexpected recording: {spec:?}"));
    }
    let file = std::io::BufWriter::new(std::fs::File::create(out)?);
    let file = encode(mixed(&mut readers), spec.sample_rate, file)?;
    file.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    Ok(())
}

/// The tracks summed sample by sample (both start when the meeting does), clipped
/// rather than wrapped, and as long as the longest.
fn mixed<R: std::io::Read>(
    readers: &mut [hound::WavReader<R>],
) -> impl Iterator<Item = hound::Result<i16>> + '_ {
    let mut sides: Vec<_> = readers.iter_mut().map(|r| r.samples::<i16>()).collect();
    std::iter::from_fn(move || {
        let mut any = false;
        let mut sum = 0i32;
        for side in sides.iter_mut() {
            match side.next() {
                Some(Ok(v)) => {
                    sum += v as i32;
                    any = true;
                }
                Some(Err(e)) => return Some(Err(e)),
                None => {}
            }
        }
        any.then(|| Ok(sum.clamp(i16::MIN as i32, i16::MAX as i32) as i16))
    })
}

/// Opus in 20 ms packets. The encoder runs a little behind its input, so it is fed
/// silence at the end until it catches up, and the file says what of that to drop: it
/// plays exactly as long as the input.
fn encode<W: Write + Seek>(
    samples: impl Iterator<Item = hound::Result<i16>>,
    rate: u32,
    out: W,
) -> anyhow::Result<W> {
    let mut encoder = opus::Encoder::new(rate, opus::Channels::Mono, opus::Application::Voip)?;
    encoder.set_bitrate(opus::Bitrate::Bits(BITRATE))?;
    let to_48k = 48_000 / rate as u64;
    let lookahead = encoder.get_lookahead()? as u64;
    let mut webm = webm::OpusWriter::new(out, rate, u16::try_from(lookahead * to_48k)?)?;

    let mut samples = samples;
    let frame = rate as usize / 50;
    let mut pcm = Vec::with_capacity(frame);
    let mut packet = vec![0u8; 4000];
    let (mut read, mut encoded) = (0u64, 0u64);
    let mut input_done = false;
    // Each packet waits for the next, so the last one can say how much is padding.
    let mut pending: Option<Vec<u8>> = None;
    while !input_done || encoded < read + lookahead {
        pcm.clear();
        while !input_done && pcm.len() < frame {
            match samples.next() {
                Some(s) => pcm.push(s?),
                None => input_done = true,
            }
        }
        read += pcm.len() as u64;
        pcm.resize(frame, 0);
        let len = encoder.encode(&pcm, &mut packet)?;
        encoded += frame as u64;
        if let Some(p) = pending.replace(packet[..len].to_vec()) {
            webm.write(&p)?;
        }
    }
    let last = pending.ok_or_else(|| anyhow!("nothing encoded"))?;
    let padding = (encoded - read - lookahead) * to_48k;
    let length = Duration::from_secs_f64(read as f64 / rate as f64);
    Ok(webm.finish(&last, padding, length)?)
}

/// Shared links point at elchi.xyz; anything else the server answers is not opened.
pub fn is_share_url(url: &str) -> bool {
    url.starts_with("https://elchi.xyz/") || url.starts_with(&format!("{SITE_URL}/elchi/s/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(path: &Path, samples: &[i16]) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for s in samples {
            w.write_sample(*s).unwrap();
        }
        w.finalize().unwrap();
    }

    #[test]
    fn the_two_sides_are_mixed_into_one_recording() {
        let dir = tempfile::tempdir().unwrap();
        let (me, them) = (dir.path().join("me.wav"), dir.path().join("them.wav"));
        track(&me, &[100, -200, 30_000, 5]);
        track(&them, &[1, 2, 10_000]);
        let mut readers = [&me, &them].map(|p| hound::WavReader::open(p).unwrap());
        let mixed: Vec<i16> = mixed(&mut readers).map(Result::unwrap).collect();
        // Summed, clipped rather than wrapped, and as long as the longer side.
        assert_eq!(mixed, vec![101, -198, i16::MAX, 5]);
        assert_eq!(
            mixed_length(&[me, them]),
            Some(Duration::from_secs_f64(4.0 / 16_000.0))
        );
    }

    /// Decodes the shared recording as a player would: the samples it plays, at 16 kHz.
    fn play(path: &Path) -> Vec<i16> {
        let file = webm::read::opus(&std::fs::read(path).unwrap());
        assert_eq!(&file.head[..8], b"OpusHead");
        assert_eq!(file.head[9], 1, "mono");
        assert_eq!(
            u32::from_le_bytes(file.head[12..16].try_into().unwrap()),
            16_000
        );
        let pre_skip = u16::from_le_bytes([file.head[10], file.head[11]]) as u64;
        assert_eq!(file.codec_delay_ns, pre_skip * 1_000_000_000 / 48_000);

        let mut decoder = opus::Decoder::new(16_000, opus::Channels::Mono).unwrap();
        let mut pcm = Vec::new();
        for (_, packet) in &file.packets {
            let mut frame = [0i16; 5760];
            let n = decoder.decode(packet, &mut frame, false).unwrap();
            pcm.extend_from_slice(&frame[..n]);
        }
        let padding = (file.discard_padding_ns * 16_000 / 1_000_000_000) as usize;
        pcm.truncate(pcm.len() - padding);
        let played = pcm.split_off(pre_skip as usize / 3);
        assert_eq!(file.duration_ms, played.len() as f64 / 16.0);
        played
    }

    #[test]
    fn the_shared_recording_is_small_opus_that_plays_as_long_as_the_meeting() {
        let dir = tempfile::tempdir().unwrap();
        let (me, them, out) = (
            dir.path().join("me.wav"),
            dir.path().join("them.wav"),
            dir.path().join("share.webm"),
        );
        // Ten seconds of a tone on one side, a quieter one on the other for six: not a
        // whole number of 20 ms frames, so the end is trimmed.
        let tone = |hz: f64, amp: f64, n: usize| -> Vec<i16> {
            (0..n)
                .map(|i| {
                    (amp * (2.0 * std::f64::consts::PI * hz * i as f64 / 16_000.0).sin()) as i16
                })
                .collect()
        };
        let len = 160_007;
        track(&me, &tone(440.0, 8_000.0, len));
        track(&them, &tone(1_000.0, 4_000.0, 96_000));
        let tracks = vec![me.clone(), them.clone()];
        mix(&tracks, &out).unwrap();

        let size = std::fs::metadata(&out).unwrap().len();
        let wav = std::fs::metadata(&me).unwrap().len();
        assert!(size < wav / 8, "{size} bytes against {wav} as WAV");

        let played = play(&out);
        assert_eq!(played.len(), len);
        // Lossy, but the same sound: compare loudness where only the first side plays.
        let rms = |s: &[i16]| {
            (s.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / s.len() as f64).sqrt()
        };
        let mut readers = [&me, &them].map(|p| hound::WavReader::open(p).unwrap());
        let original: Vec<i16> = mixed(&mut readers).map(Result::unwrap).collect();
        let (a, b) = (
            rms(&played[100_000..150_000]),
            rms(&original[100_000..150_000]),
        );
        assert!((a / b - 1.0).abs() < 0.1, "{a} against {b}");
    }

    #[test]
    fn only_elchis_own_links_are_trusted() {
        assert!(is_share_url("https://elchi.xyz/AbCdEfGhIjKlMnOpQrStUv"));
        assert!(is_share_url(
            "https://speech.patientdesk.ai/elchi/s/AbCdEfGhIjKlMnOpQrStUv"
        ));
        assert!(!is_share_url("https://elchi.xyz.evil.example/x"));
        assert!(!is_share_url("http://elchi.xyz/x"));
    }
}
