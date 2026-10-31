//! What a correction teaches: given the text Eshlik pasted and the same text after
//! the user edited it, the words it should remember ("Kan" was really "Kaan").
//!
//! Only small, local fixes are lessons. A rewrite, a reworded sentence or a grammar
//! fix teaches nothing about how names and terms sound, so it is ignored. A word is
//! learned when it looks like the kind dictation gets wrong: a name or brand (it has
//! a capital letter), or a long term that is more than an inflection of what was
//! heard. Everything here is pure, so it is tested on its own.

/// A word to remember, and how the recognizer wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lesson {
    pub word: String,
    pub heard: String,
    /// A phrase misheard as another ("VR format in" for "we are formating"), as
    /// opposed to a name or a term.
    pub phrase: bool,
}

/// At most this many lessons from one edit: more means the text was rewritten.
const MAX_LESSONS: usize = 3;
/// Share of the pasted words that must survive the edit for it to count as a correction.
const MIN_KEPT: f64 = 0.5;
/// How alike the heard and the corrected word must be (1 - edit distance / longer length).
const MIN_SIMILARITY: f64 = 0.5;

/// Turkish-aware lower case: İ is i and I is ı, which `to_lowercase` gets wrong for I.
pub fn fold(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'I' => 'ı',
            'İ' => 'i',
            _ => c,
        })
        .flat_map(char::to_lowercase)
        .collect()
}

/// A word stripped of the punctuation around it ("Kaan'a," -> "Kaan'a").
fn core(token: &str) -> &str {
    token
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '\'' && c != '’')
        .trim_matches(|c| c == '\'' || c == '’')
}

/// The part before a Turkish suffix apostrophe ("Kaan'a" -> "Kaan").
fn stem(word: &str) -> &str {
    word.split(['\'', '’']).next().unwrap_or(word)
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + usize::from(ca != cb))
                .min(prev[j + 1] + 1)
                .min(cur[j] + 1);
        }
        prev = cur;
    }
    prev[b.len()]
}

pub fn similarity(a: &str, b: &str) -> f64 {
    let longest = a.chars().count().max(b.chars().count());
    if longest == 0 {
        return 1.0;
    }
    1.0 - levenshtein(a, b) as f64 / longest as f64
}

/// How an acronym sounds when its letters are read out in English ("LG" -> "elji"):
/// a name is often misheard as letters ("Elchi" written "LG"), and its spelling alone
/// looks nothing like the name.
fn spoken_letters(word: &str) -> Option<String> {
    let n = word.chars().count();
    if !(2..=5).contains(&n) || !word.chars().all(|c| c.is_ascii_uppercase()) {
        return None;
    }
    Some(
        word.chars()
            .map(|c| match c {
                'A' => "ey",
                'B' => "bi",
                'C' => "si",
                'D' => "di",
                'E' => "i",
                'F' => "ef",
                'G' => "ji",
                'H' => "eyç",
                'I' => "ay",
                'J' => "jey",
                'K' => "key",
                'L' => "el",
                'M' => "em",
                'N' => "en",
                'O' => "o",
                'P' => "pi",
                'Q' => "kyu",
                'R' => "ar",
                'S' => "es",
                'T' => "ti",
                'U' => "yu",
                'V' => "vi",
                'W' => "dabılyu",
                'X' => "eks",
                'Y' => "vay",
                _ => "zi",
            })
            .collect(),
    )
}

/// How a word or phrase sounds, roughly, in a form two spellings of the same
/// sounds share: acronyms read out as letters, Turkish and English letters that
/// sound alike made one (ç/c/j, ş/s/z, ı/i, w/v, ...), doubled letters single, and
/// spaces, hyphens and apostrophes gone. "VR format in" -> "viarformatin",
/// "we are formating" -> "vearformatin".
pub fn sound_key(text: &str) -> String {
    let spoken: String = text
        .split_whitespace()
        .map(|t| {
            let c = core(t);
            spoken_letters(c).unwrap_or_else(|| fold(c))
        })
        .collect();
    let s = spoken
        .replace("ch", "c")
        .replace("sh", "s")
        .replace("th", "t")
        .replace("ph", "f")
        .replace("ck", "k");
    let mut out = String::new();
    for c in s.chars().filter(|c| c.is_alphanumeric()) {
        let m = match c {
            'ç' | 'j' => 'c',
            'ş' | 'z' => 's',
            'ğ' => 'g',
            'ı' | 'y' => 'i',
            'ö' => 'o',
            'ü' => 'u',
            'w' => 'v',
            'q' => 'k',
            'â' => 'a',
            'î' => 'i',
            'û' => 'u',
            c => c,
        };
        if !out.ends_with(m) {
            out.push(m);
        }
    }
    out
}

/// How alike two words or phrases sound (1 is the same), by their sound keys.
pub fn sound_similarity(a: &str, b: &str) -> f64 {
    similarity(&sound_key(a), &sound_key(b))
}

/// A phrase of several words corrected into another is a mishearing, not a
/// rewording, when the two sound this much alike.
const PHRASE_SIMILARITY: f64 = 0.65;
/// The longest stretch of words, on either side, a phrase correction may cover.
const MAX_PHRASE_WORDS: usize = 4;

/// An inflection rather than a different word: the same start, and an ending that
/// grew, shrank or swapped its last letter, as Turkish suffixes do ("evde" ->
/// "evden", "geleceğim" -> "geleceğiz"). A letter fixed inside a term
/// ("kubernetis" -> "kubernetes") is not one.
fn only_suffix_changed(heard: &str, word: &str) -> bool {
    let (h, w): (Vec<char>, Vec<char>) = (heard.chars().collect(), word.chars().collect());
    let common = h.iter().zip(&w).take_while(|(a, b)| a == b).count();
    let longest = h.len().max(w.len());
    if common + 3 < longest {
        return false;
    }
    h.len() != w.len() || common + 1 == longest
}

/// Indices of matching tokens (a longest common subsequence of folded words).
fn alignment(a: &[String], b: &[String]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len(), b.len());
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let (mut i, mut j, mut out) = (0, 0, Vec::new());
    while i < n && j < m {
        if a[i] == b[j] {
            out.push((i, j));
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out
}

/// What the edit from `pasted` to `edited` teaches, if anything, with no spell
/// checker to say which words are common (the strict rules).
#[cfg(test)]
pub fn lessons(pasted: &str, edited: &str) -> Vec<Lesson> {
    lessons_with(pasted, edited, &|_| None)
}

/// Whether a changed pair of words is a lesson: `heard` corrected to `word`.
/// `known` says whether a word is in the Turkish or English dictionary (None when
/// there is no spell checker): a lowercase correction is a lesson only when the new
/// word is not an ordinary one ("petro" -> "spero" is; "gitti" -> "geldi" is not).
fn lesson(
    heard: &str,
    word: &str,
    sentence_start: bool,
    known: &dyn Fn(&str) -> Option<bool>,
) -> Option<Lesson> {
    let (fh, fw) = (fold(heard), fold(word));
    let n = word.chars().count();
    if !(3..=40).contains(&n) || !word.chars().any(char::is_alphabetic) || fh == fw {
        return None;
    }
    if similarity(&fh, &fw).max(sound_similarity(heard, word)) < MIN_SIMILARITY {
        return None; // a different word chosen, not a mis-hearing fixed
    }
    // A capital is evidence of a name only mid-sentence; at the start every word has one.
    let capitalised = word.chars().any(char::is_uppercase)
        && (!sentence_start || word.chars().skip(1).any(char::is_uppercase));
    let learnable = capitalised
        || (!only_suffix_changed(&fh, &fw)
            && match known(word) {
                Some(is_known) => !is_known && n >= 4,
                None => n >= 6,
            });
    learnable.then(|| Lesson {
        word: word.to_string(),
        heard: heard.to_string(),
        phrase: false,
    })
}

pub fn lessons_with(
    pasted: &str,
    edited: &str,
    known: &dyn Fn(&str) -> Option<bool>,
) -> Vec<Lesson> {
    let a: Vec<&str> = pasted
        .split_whitespace()
        .filter(|t| !core(t).is_empty())
        .collect();
    let b: Vec<&str> = edited
        .split_whitespace()
        .filter(|t| !core(t).is_empty())
        .collect();
    if a.is_empty() || b.is_empty() {
        return vec![];
    }
    let fa: Vec<String> = a.iter().map(|t| fold(core(t))).collect();
    let fb: Vec<String> = b.iter().map(|t| fold(core(t))).collect();
    let matched = alignment(&fa, &fb);
    if (matched.len() as f64) < MIN_KEPT * a.len().max(b.len()) as f64 {
        return vec![]; // rewritten, not corrected
    }

    // The gaps between matched words are what changed: (pasted range, edited range).
    let mut gaps = Vec::new();
    let (mut pi, mut pj) = (0, 0);
    for &(i, j) in matched.iter().chain(std::iter::once(&(a.len(), b.len()))) {
        if i > pi || j > pj {
            gaps.push((pi..i, pj..j));
        }
        pi = i + 1;
        pj = j + 1;
    }
    let starts = |j: usize| j == 0 || b[j - 1].ends_with(['.', '!', '?', ':']);

    let mut out: Vec<Lesson> = Vec::new();
    let push = |l: Lesson, out: &mut Vec<Lesson>| {
        if !out.iter().any(|x| fold(&x.word) == fold(&l.word)) {
            out.push(l);
        }
    };
    // Matched words are equal once folded; one whose case was changed to a capital in
    // the middle of a sentence ("elchi" -> "Elchi") names something.
    for &(i, j) in &matched {
        let (heard, word) = (stem(core(a[i])), stem(core(b[j])));
        if heard != word
            && word.chars().any(char::is_uppercase)
            && !heard.chars().any(char::is_uppercase)
            && !starts(j)
            && word.chars().count() >= 3
        {
            push(
                Lesson {
                    word: word.to_string(),
                    heard: heard.to_string(),
                    phrase: false,
                },
                &mut out,
            );
        }
    }
    for (ra, rb) in gaps {
        if ra.is_empty()
            || rb.is_empty()
            || ra.len() > MAX_PHRASE_WORDS
            || rb.len() > MAX_PHRASE_WORDS
        {
            continue; // an insertion, a deletion, or too long to be one mishearing
        }
        let join = |words: &[&str], r: std::ops::Range<usize>| {
            r.map(|k| core(words[k])).collect::<Vec<_>>().join(" ")
        };
        let before = out.len();
        if ra.len() == rb.len() && ra.len() <= 2 {
            // Word for word: "this petro" -> "the spero" is two fixes, judged apart.
            for (i, j) in ra.clone().zip(rb.clone()) {
                if let Some(l) = lesson(stem(core(a[i])), stem(core(b[j])), starts(j), known) {
                    push(l, &mut out);
                }
            }
        } else if ra.len() <= 2 && rb.len() <= 2 {
            // Split or joined: "patient desk" -> "PatientDesk".
            let heard = ra
                .clone()
                .map(|k| stem(core(a[k])))
                .collect::<Vec<_>>()
                .join(" ");
            let word = rb
                .clone()
                .map(|k| stem(core(b[k])))
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(l) = lesson(&heard, &word, starts(rb.start), known) {
                push(l, &mut out);
            }
        }
        // Several words corrected together, and nothing in them learned word by word:
        // a mishearing of the phrase when it sounds like what was meant ("VR format
        // in" -> "we are formating"), a rewording when it does not.
        // Two words a side are judged word for word above; a phrase is three or more.
        if out.len() == before && ra.len().max(rb.len()) >= 3 {
            let (heard, word) = (join(&a, ra.clone()), join(&b, rb.clone()));
            if sound_similarity(&heard, &word) >= PHRASE_SIMILARITY {
                push(
                    Lesson {
                        word,
                        heard,
                        phrase: true,
                    },
                    &mut out,
                );
            }
        }
    }
    if out.len() > MAX_LESSONS {
        return vec![];
    }
    out
}

/// The corrected text, when `edited` is a correction of `pasted` rather than more
/// typing after it or a rewrite: most words kept, and something in it changed.
pub fn correction(pasted: &str, edited: &str) -> Option<String> {
    let edited = edited.trim();
    let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let (p, e) = (norm(pasted), norm(edited));
    if p == e || e.is_empty() || e.starts_with(&p) {
        return None; // unchanged, or only typed on after it
    }
    let fa: Vec<String> = p.split(' ').map(|t| fold(core(t))).collect();
    let fb: Vec<String> = e.split(' ').map(|t| fold(core(t))).collect();
    let kept = alignment(&fa, &fb).len();
    (kept as f64 >= MIN_KEPT * fa.len().max(fb.len()) as f64).then(|| edited.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn learned(pasted: &str, edited: &str) -> Vec<(String, String)> {
        lessons(pasted, edited)
            .into_iter()
            .map(|l| (l.word, l.heard))
            .collect()
    }

    fn one(word: &str, heard: &str) -> Vec<(String, String)> {
        vec![(word.to_string(), heard.to_string())]
    }

    #[test]
    fn a_misheard_name_is_learned_without_its_suffix() {
        assert_eq!(
            learned(
                "Raporu Kan'a gönder, yarın görüşürüz.",
                "Raporu Kaan'a gönder, yarın görüşürüz."
            ),
            one("Kaan", "Kan")
        );
        assert_eq!(
            learned(
                "Toplantıya kan ile gideceğim.",
                "Toplantıya Kaan ile gideceğim."
            ),
            one("Kaan", "kan")
        );
    }

    #[test]
    fn brands_and_jargon_are_learned() {
        assert_eq!(
            learned(
                "Bunu pacientdesk üzerinden yap.",
                "Bunu PatientDesk üzerinden yap."
            ),
            one("PatientDesk", "pacientdesk")
        );
        assert_eq!(
            learned(
                "Kubernetis cluster'ı yeniden başlat.",
                "Kubernetes cluster'ı yeniden başlat."
            ),
            one("Kubernetes", "Kubernetis")
        );
        assert_eq!(
            learned(
                "Veriyi postgreskl ile sakla.",
                "Veriyi postgresql ile sakla."
            ),
            one("postgresql", "postgreskl")
        );
        assert_eq!(
            learned("Bunu patient desk ile yap.", "Bunu PatientDesk ile yap."),
            one("PatientDesk", "patient desk")
        );
    }

    #[test]
    fn a_name_capitalised_mid_sentence_is_learned_but_not_a_sentence_start() {
        assert_eq!(
            learned("Bugün elchi ile yazdım.", "Bugün Elchi ile yazdım."),
            one("Elchi", "elchi")
        );
        assert!(learned("tamam. yarın gelirim.", "Tamam. Yarın gelirim.").is_empty());
    }

    #[test]
    fn grammar_and_word_choice_are_not_lessons() {
        assert!(learned(
            "Yarın geleceğim, sen de gel.",
            "Yarın geleceğiz, sen de gel."
        )
        .is_empty());
        assert!(learned("Bunu yarın evde konuşuruz.", "Bunu yarın evden konuşuruz.").is_empty());
        assert!(learned("Kan tahlili yarın çıkacak.", "Kaan tahlili yarın çıkacak.").is_empty()); // a sentence start says nothing
        assert!(learned("Bir şey söyleyeceğim.", "Biz şey söyleyeceğim.").is_empty()); // short and lowercase
        assert!(learned("Toplantı çok güzeldi.", "Toplantı çok verimliydi.").is_empty()); // a different word
        assert!(learned("Raporu yarın gönder.", "Raporu yarın sabah gönder.").is_empty()); // an addition
        assert!(learned("Raporu yarın sabah gönder.", "Raporu yarın gönder.").is_empty());
        // a deletion
    }

    #[test]
    fn a_rewrite_teaches_nothing() {
        assert!(learned(
            "Toplantıyı yarına alalım, herkese haber ver.",
            "Lütfen ekibe toplantının ertelendiğini bildir."
        )
        .is_empty());
        assert!(learned("Merhaba", "").is_empty());
        assert!(learned("Aynı metin.", "Aynı metin.").is_empty());
    }

    #[test]
    fn turkish_case_folds_correctly() {
        assert_eq!(fold("İSTANBUL Iğdır"), "istanbul ığdır");
        assert_eq!(
            learned("Yarın ıstanbul'a gidiyorum.", "Yarın İstanbul'a gidiyorum."),
            one("İstanbul", "ıstanbul")
        );
    }

    #[test]
    fn a_name_misheard_as_letters_is_learned() {
        // Seen in the app: "LG" corrected to "Elchi" in Claude's message box.
        assert_eq!(
            learned("Bunu LG ile yazdım.", "Bunu Elchi ile yazdım."),
            one("Elchi", "LG")
        );
        assert!(learned("Bunu TV ile izledim.", "Bunu tablet ile izledim.").is_empty());
    }

    #[test]
    fn a_phrase_misheard_as_another_is_learned_and_a_rewording_is_not() {
        // Seen in the app: "VR format in" corrected to "we are formating" in Claude.
        let got = lessons(
            "Right now it shows bi-chimland because VR format in the back-end.",
            "Right now it shows bicimlendirildi because we are formating the back-end.",
        );
        assert!(
            got.iter()
                .any(|l| l.phrase && l.heard == "VR format in" && l.word == "we are formating"),
            "{got:?}"
        );
        assert!(lessons(
            "Toplantı bugün çok güzel geçti.",
            "Toplantı bugün oldukça verimli oldu."
        )
        .is_empty());
        assert!(lessons(
            "Bunu yarın sabah hallederiz.",
            "Bunu haftaya pazartesi hallederiz."
        )
        .is_empty());
    }

    #[test]
    fn sound_keys_make_alike_sounds_one() {
        assert_eq!(sound_key("VR format in"), "viarformatin");
        assert_eq!(sound_key("we are formating"), "veareformating");
        assert!(sound_similarity("VR format in", "we are formating") >= PHRASE_SIMILARITY);
        assert!(sound_similarity("bi-chimland", "bicimlendirildi") >= 0.5);
        assert!(sound_similarity("güzeldi", "verimliydi") < 0.5);
    }

    #[test]
    fn two_changed_words_are_judged_one_by_one() {
        // Seen in the app: "this petro" -> "the spero" was learned as "the spero".
        let known =
            |w: &str| Some(["the", "this", "fix", "repo"].contains(&w.to_lowercase().as_str()));
        let got: Vec<_> = lessons_with("Fix this petro repo.", "Fix the spero repo.", &known)
            .into_iter()
            .map(|l| (l.word, l.heard))
            .collect();
        assert_eq!(got, one("spero", "petro"));
        assert!(
            learned("Fix this petro repo.", "Fix the spero repo.").is_empty(),
            "no spell checker: strict"
        );
    }

    #[test]
    fn a_lowercase_term_is_learned_only_when_it_is_not_a_common_word() {
        let dict = |w: &str| Some(["geldi", "gitti"].contains(&w));
        let l = |p: &str, e: &str| {
            lessons_with(p, e, &dict)
                .into_iter()
                .map(|l| l.word)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            l(
                "Bunu kubectl ile değil kubetcl ile yap.",
                "Bunu kubectl ile değil kubectl ile yap."
            ),
            vec!["kubectl"]
        );
        assert!(l("Ali dün gitti.", "Ali dün geldi.").is_empty());
        assert!(
            l("Yarın evde konuşuruz.", "Yarın evden konuşuruz.").is_empty(),
            "an inflection"
        );
    }

    #[test]
    fn a_correction_is_told_from_typing_on_and_from_a_rewrite() {
        assert_eq!(
            correction("Fix this petro repo.", "Fix the spero repo.").as_deref(),
            Some("Fix the spero repo.")
        );
        assert_eq!(
            correction("Fix this repo.", "Fix this repo. And the CI too."),
            None,
            "typed on after it"
        );
        assert_eq!(correction("Fix this repo.", "Fix this repo."), None);
        assert_eq!(
            correction(
                "Toplantıyı yarına alalım, herkese haber ver.",
                "Lütfen ekibe bildir."
            ),
            None
        );
    }

    #[test]
    fn several_names_in_one_edit_are_all_learned() {
        assert_eq!(
            learned(
                "Yarın Kan ve Selen gelecek.",
                "Yarın Kaan ve Selin gelecek."
            ),
            vec![
                ("Kaan".into(), "Kan".into()),
                ("Selin".into(), "Selen".into())
            ]
        );
    }
}
