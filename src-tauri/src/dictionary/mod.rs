//! Eshlik's personal dictionary: the names, brands and terms a user dictates, and how
//! the recognizer tends to mishear them.
//!
//! Entries come from three places: corrections Eshlik notices (`learn`; on macOS it
//! reads the text field back after pasting, see `watch`), edits made to a dictation
//! in History, and words the user adds. They are used where context decides: the
//! formatter (crate::elchi_pro::format) gets every entry with its misheard forms and
//! fixes a word only where it fits ("Kan'a gönder" -> "Kaan'a gönder", never "kan
//! tahlili"), and Duyu Pro gets the words as a recognition hint. They are not blindly
//! substituted into transcripts, which is what Handy's custom words do.

pub mod learn;
pub mod spell;
#[cfg(target_os = "macos")]
pub mod watch;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::settings::{get_settings, write_settings};

/// The dictionary keeps at most this many entries; past it, the oldest learned ones go.
const MAX_WORDS: usize = 500;
/// The formatter gets the most recent entries, up to this many.
const MAX_FOR_FORMATTER: usize = 200;

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct DictionaryWord {
    /// As the user writes it: "Kaan", "PatientDesk".
    pub word: String,
    /// How Eshlik wrote it before it was corrected: "Kan".
    #[serde(default)]
    pub heard: Vec<String>,
    /// Learned from a correction, rather than added by the user.
    #[serde(default)]
    pub learned: bool,
    /// Unix seconds.
    #[serde(default)]
    pub added_at: i64,
    /// A phrase the recognizer misheard as another ("VR format in" for "we are
    /// formating"), not a name or a term: the dictionary lists it apart.
    #[serde(default)]
    pub phrase: bool,
}

fn key(word: &str) -> String {
    learn::fold(word.trim())
}

fn changed(app: &AppHandle, words: &[DictionaryWord]) {
    let _ = app.emit("dictionary-changed", words.to_vec());
}

/// Adds `word` (or, if it is already there, adds `heard` to how it was misheard).
/// Returns the entry if anything changed.
pub fn add(
    app: &AppHandle,
    word: &str,
    heard: Option<&str>,
    learned: bool,
    phrase: bool,
) -> Option<DictionaryWord> {
    let word = word.trim();
    if word.is_empty() || word.chars().count() > 40 {
        return None;
    }
    // A misheard form is any other spelling, case included ("elchi" for "Elchi").
    let heard = heard.map(str::trim).filter(|h| !h.is_empty() && *h != word);
    let mut settings = get_settings(app);
    let dict = &mut settings.elchi_dictionary;
    let entry = if let Some(e) = dict.iter_mut().find(|e| key(&e.word) == key(word)) {
        match heard {
            Some(h) if !e.heard.iter().any(|x| x == h) => {
                e.heard.push(h.to_string());
                e.clone()
            }
            _ => return None,
        }
    } else {
        let e = DictionaryWord {
            word: word.to_string(),
            heard: heard.map(|h| vec![h.to_string()]).unwrap_or_default(),
            learned,
            added_at: chrono::Utc::now().timestamp(),
            phrase,
        };
        dict.push(e.clone());
        while dict.len() > MAX_WORDS {
            let oldest = dict
                .iter()
                .enumerate()
                .filter(|(_, e)| e.learned)
                .min_by_key(|(_, e)| e.added_at)
                .or_else(|| dict.iter().enumerate().min_by_key(|(_, e)| e.added_at))
                .map(|(i, _)| i);
            match oldest {
                Some(i) => {
                    dict.remove(i);
                }
                None => break,
            }
        }
        e
    };
    let words = settings.elchi_dictionary.clone();
    write_settings(app, settings);
    changed(app, &words);
    Some(entry)
}

pub fn remove(app: &AppHandle, word: &str) -> Vec<DictionaryWord> {
    let mut settings = get_settings(app);
    settings
        .elchi_dictionary
        .retain(|e| key(&e.word) != key(word));
    let words = settings.elchi_dictionary.clone();
    write_settings(app, settings);
    changed(app, &words);
    words
}

/// Learns from the user's edit of a dictation; tells the interface what was learned.
pub fn learn_from_edit(app: &AppHandle, pasted: &str, edited: &str) -> Vec<DictionaryWord> {
    if !get_settings(app).elchi_dictionary_learn {
        return vec![];
    }
    let known = |w: &str| spell::is_known(app, w);
    let learned: Vec<DictionaryWord> = learn::lessons_with(pasted, edited, &known)
        .into_iter()
        .filter_map(|l| add(app, &l.word, Some(&l.heard), true, l.phrase))
        .collect();
    if !learned.is_empty() {
        log::info!(
            "Dictionary learned {} word(s) from a correction",
            learned.len()
        );
        let _ = app.emit("dictionary-learned", learned.clone());
    }
    learned
}

/// A dictation corrected where it was pasted (crate::dictionary::watch): the
/// correction becomes the dictation's text in history, so the home feed shows it
/// and what changed, and the dictionary learns from it. Nothing happens when the
/// change is more typing after the dictation, or a rewrite.
pub fn correct_dictation(app: &AppHandle, history_id: Option<i64>, pasted: &str, edited: &str) {
    let Some(corrected) = learn::correction(pasted, edited) else {
        return;
    };
    if let Some(id) = history_id {
        use tauri::Manager;
        if let Some(hm) =
            app.try_state::<std::sync::Arc<crate::managers::history::HistoryManager>>()
        {
            if let Err(e) = hm.correct_text(id, &corrected) {
                log::warn!("Could not save a correction to history: {e}");
            }
        }
    }
    learn_from_edit(app, pasted, &corrected);
}

/// What the formatter gets: the most recent entries, each with its misheard forms.
pub fn for_formatter(words: &[DictionaryWord]) -> Vec<DictionaryWord> {
    let mut v = words.to_vec();
    v.sort_by_key(|e| std::cmp::Reverse(e.added_at));
    v.truncate(MAX_FOR_FORMATTER);
    v
}

/// `text` with every misheard form the dictionary knows written as the user writes it
/// ("elçi" -> "Elchi"), whole words only, any case. Meetings use it on each line; dictation
/// gets the same from the formatter.
///
/// The recognizer is never given the words as a prompt: measured 2026-10-16 on a
/// meeting's call audio, the one-word prompt "Elchi" lost a third of the words (253
/// against 373), left 19 utterances empty and made the decoder loop ("beyler, beyler,
/// beyler, beyler").
pub fn respell(words: &[DictionaryWord], text: &str) -> String {
    let mut out = text.to_string();
    for entry in words {
        for heard in &entry.heard {
            let Ok(re) = regex::Regex::new(&format!(r"(?i)\b{}\b", regex::escape(heard))) else {
                continue;
            };
            out = re
                .replace_all(&out, regex::NoExpand(&entry.word))
                .into_owned();
        }
    }
    out
}

#[tauri::command]
#[specta::specta]
pub fn get_dictionary(app: AppHandle) -> Vec<DictionaryWord> {
    get_settings(&app).elchi_dictionary
}

#[tauri::command]
#[specta::specta]
pub fn add_dictionary_word(app: AppHandle, word: String) -> Vec<DictionaryWord> {
    add(&app, &word, None, false, false);
    get_settings(&app).elchi_dictionary
}

#[tauri::command]
#[specta::specta]
pub fn remove_dictionary_word(app: AppHandle, word: String) -> Vec<DictionaryWord> {
    remove(&app, &word)
}

/// Whether corrections teach the dictionary.
#[tauri::command]
#[specta::specta]
pub fn set_dictionary_learning(app: AppHandle, enabled: bool) {
    let mut settings = get_settings(&app);
    settings.elchi_dictionary_learn = enabled;
    write_settings(&app, settings);
}

#[cfg(test)]
mod tests {
    use super::{respell, DictionaryWord};

    #[test]
    fn misheard_forms_are_respelled_as_whole_words() {
        let words = vec![DictionaryWord {
            word: "Elchi".into(),
            heard: vec!["elçi".into(), "Tarık Paşa".into()],
            learned: true,
            added_at: 0,
            phrase: false,
        }];
        assert_eq!(
            respell(&words, "Elçi ile, elçi'yi; tarık paşa elçiler"),
            "Elchi ile, Elchi'yi; Elchi elçiler"
        );
        assert_eq!(respell(&[], "aynı"), "aynı");
    }
}
