//! Duyu-small: Eshlik's on-device Turkish + English recognizer.
//!
//! A native port of the reference engine published with the model
//! (https://huggingface.co/KaanAydinli/Duyu-small, `duyu_small/`): log-mel
//! fbank -> `encoder_pre` -> `encoder_pass` run 3x with learned per-pass
//! gates -> `encoder_post` (CTC) -> attention beam search with CTC rescoring
//! over `decoder`. Everything runs on the CPU through ONNX Runtime.
//!
//! Ported from Python to Rust, and changed, from `duyu_small/` in that
//! repository by the Duyu-small authors, licensed under the Apache License 2.0
//! (https://www.apache.org/licenses/LICENSE-2.0); see THIRD_PARTY_NOTICES.md.
//!
//! Model directory layout (the Hugging Face repo's):
//! `engine.json`, `spm.model`, `fbank.npz`, `passes.npz`, `<quant>/{encoder_pre,
//! encoder_pass,encoder_post,decoder}.onnx`.

mod decode;
mod fbank;
mod npz;
mod tokenizer;

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use ndarray::{Array2, Array3, ArrayView3, Axis};
use ort::inputs;
use ort::session::Session;
use ort::value::TensorRef;
use serde::Deserialize;

pub use decode::LangPrompt;
use decode::{beam_search, ctc_greedy_ids, BeamConfig, CtcLogProbs, Special};
use fbank::{Fbank, FEAT_DIM};
use tokenizer::Tokenizer;

pub const SAMPLE_RATE: usize = 16_000;
/// Push-to-talk cuts the last word: trailing silence for the decoder.
const TAIL_PAD_S: f32 = 0.4;
const DEFAULT_BEAM: usize = 5;
const CTC_WEIGHT: f64 = 0.3;

/// The files a Duyu-small model directory needs, relative to its root.
pub fn required_files(quant: &str) -> Vec<String> {
    let mut files: Vec<String> = ["engine.json", "spm.model", "fbank.npz", "passes.npz"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for graph in ["encoder_pre", "encoder_pass", "encoder_post", "decoder"] {
        files.push(format!("{quant}/{graph}.onnx"));
    }
    files
}

#[derive(Deserialize)]
struct EngineMeta {
    pad: i64,
    bos: i64,
    eos: i64,
    lang: std::collections::HashMap<String, i64>,
    style: std::collections::HashMap<String, i64>,
    max_positions: usize,
    d_model: usize,
}

pub struct DuyuModel {
    pre: Session,
    pass: Session,
    post: Session,
    decoder: Option<Session>,
    fbank: Fbank,
    gates: Vec<f32>,
    pass_embed: Vec<Vec<f32>>,
    tok: Tokenizer,
    sp: Special,
    max_positions: usize,
    d_model: usize,
}

impl DuyuModel {
    /// Loads a Duyu-small directory at the given precision (`int8`, `q4` or `fp32`).
    pub fn load(dir: &Path, quant: &str) -> Result<Self> {
        let meta: EngineMeta = serde_json::from_slice(
            &std::fs::read(dir.join("engine.json")).context("read engine.json")?,
        )
        .context("parse engine.json")?;
        let lang = |k: &str| {
            meta.lang
                .get(k)
                .copied()
                .ok_or_else(|| anyhow!("engine.json: no lang {k}"))
        };
        let mut control: Vec<i64> = meta
            .lang
            .values()
            .chain(meta.style.values())
            .copied()
            .collect();
        control.sort_unstable();
        control.dedup();
        let sp = Special {
            pad: meta.pad,
            bos: meta.bos,
            eos: meta.eos,
            lang_tr: lang("tr")?,
            lang_en: lang("en")?,
            lang_mix: lang("mix")?,
            style_cased: *meta
                .style
                .get("cased")
                .ok_or_else(|| anyhow!("engine.json: no cased style"))?,
            control,
        };

        let tables = npz::load_f32(&dir.join("fbank.npz"))?;
        let get = |m: &std::collections::HashMap<String, npz::NpyArray>, k: &str| {
            m.get(k)
                .map(|a| a.data.clone())
                .ok_or_else(|| anyhow!("missing table {k}"))
        };
        let fbank = Fbank::new(&get(&tables, "window")?, &get(&tables, "mel")?)?;

        let passes = npz::load_f32(&dir.join("passes.npz"))?;
        let gates = get(&passes, "gates")?;
        let embed = passes
            .get("pass_embed")
            .ok_or_else(|| anyhow!("missing table pass_embed"))?;
        anyhow::ensure!(
            embed.shape == [gates.len(), meta.d_model],
            "pass_embed shape {:?} does not match {} passes x d {}",
            embed.shape,
            gates.len(),
            meta.d_model
        );
        let pass_embed = embed
            .data
            .chunks(meta.d_model)
            .map(|c| c.to_vec())
            .collect();

        let qdir = dir.join(quant);
        let threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4))
            .unwrap_or(4);
        let session = |name: &str| -> Result<Session> {
            let path = qdir.join(format!("{name}.onnx"));
            transcribe_rs::onnx::session::create_session_with_threads(&path, threads)
                .with_context(|| format!("load {}", path.display()))
        };
        let decoder_path = qdir.join("decoder.onnx");
        Ok(Self {
            pre: session("encoder_pre")?,
            pass: session("encoder_pass")?,
            post: session("encoder_post")?,
            decoder: if decoder_path.exists() {
                Some(session("decoder")?)
            } else {
                None
            },
            fbank,
            gates,
            pass_embed,
            tok: Tokenizer::load(&dir.join("spm.model"))?,
            sp,
            max_positions: meta.max_positions,
            d_model: meta.d_model,
        })
    }

    /// Any length of 16 kHz mono audio; long input is cut at quiet points.
    pub fn transcribe(&mut self, audio: &[f32], lang: LangPrompt) -> Result<String> {
        let mut texts = Vec::new();
        for part in chunks(audio) {
            let text = self.transcribe_utterance(part, lang)?;
            if !text.is_empty() {
                texts.push(text);
            }
        }
        Ok(texts.join(" "))
    }

    fn transcribe_utterance(&mut self, audio: &[f32], lang: LangPrompt) -> Result<String> {
        let mut x = Vec::with_capacity(audio.len() + (TAIL_PAD_S * SAMPLE_RATE as f32) as usize);
        x.extend_from_slice(audio);
        x.resize(
            audio.len() + (TAIL_PAD_S * SAMPLE_RATE as f32) as usize,
            0.0,
        );

        let (h, logp, frames, vocab) = self.encode(&x)?;
        let ctc = CtcLogProbs {
            data: &logp,
            frames,
            vocab,
        };
        let ids = match self.decoder.as_mut() {
            None => ctc_greedy_ids(&ctc, self.sp.pad),
            Some(decoder) => {
                let cfg = BeamConfig {
                    beam: DEFAULT_BEAM,
                    lang,
                    ctc_weight: CTC_WEIGHT,
                    max_positions: self.max_positions,
                };
                // Memory repeated per beam once; the graph has no KV cache, so
                // each step re-runs the whole prefix for the K beams.
                let memory = h
                    .broadcast((cfg.beam, h.shape()[1], h.shape()[2]))
                    .ok_or_else(|| anyhow!("cannot broadcast encoder memory"))?
                    .to_owned();
                beam_search(&self.sp, &ctc, &cfg, |tokens, k, len| {
                    run_decoder(decoder, tokens, k, len, memory.view())
                })?
            }
        };
        Ok(self.tok.decode(&ids))
    }

    /// -> encoder output (1, T', d), CTC log-probs (T' x V row-major), T', V.
    fn encode(&mut self, wav: &[f32]) -> Result<(Array3<f32>, Vec<f32>, usize, usize)> {
        let (feats, frames) = self.fbank.compute(wav);
        let feats = Array3::from_shape_vec((1, frames, FEAT_DIM), feats)?;

        let mut x = {
            let out = self
                .pre
                .run(inputs!["feats" => TensorRef::from_array_view(feats.view())?])?;
            out[0]
                .try_extract_array::<f32>()?
                .to_owned()
                .into_dimensionality::<ndarray::Ix3>()?
        };
        anyhow::ensure!(
            x.shape()[2] == self.d_model,
            "encoder width {} != {}",
            x.shape()[2],
            self.d_model
        );

        for p in 0..self.gates.len() {
            let embed = ndarray::ArrayView1::from(&self.pass_embed[p][..]);
            let x_in = &x + &embed;
            let y = {
                let out = self
                    .pass
                    .run(inputs!["x" => TensorRef::from_array_view(x_in.view())?])?;
                out[0]
                    .try_extract_array::<f32>()?
                    .to_owned()
                    .into_dimensionality::<ndarray::Ix3>()?
            };
            x = if p == 0 {
                y
            } else {
                &x + &((&y - &x) * self.gates[p])
            };
        }

        let logp = {
            let out = self
                .post
                .run(inputs!["x" => TensorRef::from_array_view(x.view())?])?;
            out[0]
                .try_extract_array::<f32>()?
                .to_owned()
                .into_dimensionality::<ndarray::Ix3>()?
        };
        let (t, v) = (logp.shape()[1], logp.shape()[2]);
        let logp: Array2<f32> = logp.index_axis_move(Axis(0), 0);
        Ok((x, logp.into_raw_vec_and_offset().0, t, v))
    }
}

fn run_decoder(
    decoder: &mut Session,
    tokens: &[i64],
    k: usize,
    len: usize,
    memory: ArrayView3<f32>,
) -> Result<Vec<f32>> {
    let tokens = Array2::from_shape_vec((k, len), tokens.to_vec())?;
    let out = decoder.run(inputs![
        "tokens" => TensorRef::from_array_view(tokens.view())?,
        "memory" => TensorRef::from_array_view(memory)?,
    ])?;
    let logits = out[0].try_extract_array::<f32>()?;
    let logits = logits.into_dimensionality::<ndarray::Ix3>()?;
    let last = logits.index_axis(Axis(1), len - 1);
    Ok(last.iter().copied().collect())
}

/// <= 30 s: one chunk. Longer: a cut every ~25 s at the lowest-energy 20 ms
/// frame within +-4 s of the boundary (the model is trained on <= 30 s).
fn chunks(audio: &[f32]) -> Vec<&[f32]> {
    let sr = SAMPLE_RATE;
    let (max_n, limit_n, search_n) = (25 * sr, 30 * sr, 4 * sr);
    if audio.len() <= limit_n {
        return vec![audio];
    }
    // Centred moving RMS over a 20 ms window (np.convolve mode="same").
    let frame = sr / 50;
    let mut prefix = vec![0f64; audio.len() + 1];
    for (i, &s) in audio.iter().enumerate() {
        prefix[i + 1] = prefix[i] + (s as f64) * (s as f64);
    }
    let rms = |i: usize| {
        let lo = i.saturating_sub(frame / 2);
        let hi = (i + frame / 2).min(audio.len());
        prefix[hi] - prefix[lo]
    };
    let mut out = Vec::new();
    let mut start = 0usize;
    while audio.len() - start > limit_n {
        let target = start + max_n;
        let lo = (start + sr).max(target.saturating_sub(search_n));
        let hi = (audio.len() - sr).min(target + search_n);
        let cut = if hi > lo {
            (lo..hi)
                .min_by(|&a, &b| rms(a).total_cmp(&rms(b)))
                .unwrap_or(target)
        } else {
            target
        };
        out.push(&audio[start..cut]);
        start = cut;
    }
    out.push(&audio[start..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_wav(path: &Path) -> Vec<f32> {
        let mut r = hound::WavReader::open(path).expect("open wav");
        let spec = r.spec();
        assert_eq!(
            (spec.sample_rate, spec.channels),
            (16_000, 1),
            "{}",
            path.display()
        );
        r.samples::<i16>()
            .map(|s| s.unwrap() as f32 / 32768.0)
            .collect()
    }

    /// Parity check against the reference Python engine:
    /// `DUYU_SMALL_DIR=/path/to/Duyu-small DUYU_TEST_CLIPS=/dir/with/wavs
    /// cargo test duyu -- --ignored --nocapture`
    #[test]
    #[ignore = "needs the Duyu-small model files"]
    fn transcribes_clips() {
        let dir = std::env::var("DUYU_SMALL_DIR").expect("DUYU_SMALL_DIR");
        let clips = std::env::var("DUYU_TEST_CLIPS").expect("DUYU_TEST_CLIPS");
        let t0 = std::time::Instant::now();
        let mut m = DuyuModel::load(Path::new(&dir), "int8").expect("load");
        println!("load {:?}", t0.elapsed());
        let mut paths: Vec<_> = std::fs::read_dir(&clips)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "wav"))
            .collect();
        paths.sort();
        for p in paths {
            let wav = read_wav(&p);
            for lang in [LangPrompt::Mix, LangPrompt::Auto] {
                let t = std::time::Instant::now();
                let text = m.transcribe(&wav, lang).expect("transcribe");
                let secs = wav.len() as f32 / SAMPLE_RATE as f32;
                println!(
                    "{} [{:?}] rtf {:.3}: {}",
                    p.file_name().unwrap().to_string_lossy(),
                    lang,
                    t.elapsed().as_secs_f32() / secs,
                    text
                );
            }
        }
    }

    #[test]
    fn chunks_short_audio_whole() {
        let a = vec![0f32; SAMPLE_RATE * 10];
        assert_eq!(chunks(&a).len(), 1);
        let b = vec![0.1f32; SAMPLE_RATE * 70];
        let parts = chunks(&b);
        assert!(parts.len() >= 3);
        assert_eq!(parts.iter().map(|p| p.len()).sum::<usize>(), b.len());
        assert!(parts.iter().all(|p| p.len() <= 30 * SAMPLE_RATE));
    }
}
