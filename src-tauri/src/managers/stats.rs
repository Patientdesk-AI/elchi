//! How much Eshlik has written for its user: words and dictations per day, and the
//! time that saved them. Kept in the history database (table `daily_stats`, created
//! by a migration in managers/history.rs), one row per local day, so the totals
//! survive history being trimmed or turned off.
//!
//! Time saved is what typing the words would have taken at an average typing speed,
//! less the time spent saying them.

use chrono::{Duration, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use specta::Type;

/// An average typist's speed, words per minute, the baseline for "time saved".
pub const TYPING_WPM: f64 = 40.0;
/// Speaking speed assumed for dictations recorded before stats existed.
const BACKFILL_SPEAKING_WPM: f64 = 130.0;

#[derive(Clone, Debug, Serialize, Type, PartialEq)]
pub struct DayStat {
    /// YYYY-MM-DD, local time.
    pub day: String,
    pub words: u32,
    pub dictations: u32,
}

/// A round number of words passed, and the day it happened (for the home feed).
#[derive(Clone, Debug, Serialize, Type, PartialEq)]
pub struct Milestone {
    pub words: u32,
    /// YYYY-MM-DD, local time.
    pub day: String,
}

const MILESTONES: [u64; 10] = [
    1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
];

#[derive(Clone, Debug, Serialize, Type, PartialEq)]
pub struct DictationStats {
    pub today_words: u32,
    pub week_words: u32,
    pub week_dictations: u32,
    pub week_minutes_saved: f64,
    pub total_words: u32,
    pub total_dictations: u32,
    pub total_minutes_saved: f64,
    /// Words per minute while dictating, over all time; None before the first dictation.
    pub speaking_wpm: Option<f64>,
    pub typing_wpm: f64,
    /// Days in a row with at least one dictation, ending today (or yesterday).
    pub streak_days: u32,
    /// The last seven days, oldest first, today last.
    pub days: Vec<DayStat>,
    /// Every round number of words passed so far, oldest first.
    pub milestones: Vec<Milestone>,
}

/// Words as people count them: runs of text with at least one letter or digit.
pub fn count_words(text: &str) -> u32 {
    text.split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count() as u32
}

fn minutes_saved(words: u64, audio_ms: u64) -> f64 {
    (words as f64 / TYPING_WPM - audio_ms as f64 / 60_000.0).max(0.0)
}

pub fn record(conn: &Connection, day: &str, words: u32, audio_ms: u64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO daily_stats (day, words, dictations, audio_ms) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(day) DO UPDATE SET words = words + ?2, dictations = dictations + 1, audio_ms = audio_ms + ?3",
        params![day, words, audio_ms as i64],
    )?;
    Ok(())
}

/// Once, when there are no stats yet: count the dictations already in history.
pub fn backfill_if_empty(conn: &Connection) -> rusqlite::Result<()> {
    let has_stats: Option<i64> = conn
        .query_row("SELECT 1 FROM daily_stats LIMIT 1", [], |r| r.get(0))
        .optional()?;
    if has_stats.is_some() {
        return Ok(());
    }
    let mut stmt = conn.prepare(
        "SELECT date(timestamp, 'unixepoch', 'localtime'), COALESCE(post_processed_text, transcription_text)
         FROM transcription_history",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (day, text) = row?;
        let words = count_words(&text);
        if words > 0 {
            record(
                conn,
                &day,
                words,
                (words as f64 / BACKFILL_SPEAKING_WPM * 60_000.0) as u64,
            )?;
        }
    }
    Ok(())
}

pub fn summary(conn: &Connection, today: NaiveDate) -> rusqlite::Result<DictationStats> {
    let mut by_day = std::collections::HashMap::new();
    let mut stmt = conn.prepare("SELECT day, words, dictations, audio_ms FROM daily_stats")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)? as u64,
            r.get::<_, i64>(2)? as u64,
            r.get::<_, i64>(3)? as u64,
        ))
    })?;
    let (mut total_words, mut total_dictations, mut total_ms) = (0u64, 0u64, 0u64);
    for row in rows {
        let (day, w, d, ms) = row?;
        total_words += w;
        total_dictations += d;
        total_ms += ms;
        by_day.insert(day, (w, d, ms));
    }
    let key = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let days: Vec<DayStat> = (0..7)
        .rev()
        .map(|back| {
            let d = key(today - Duration::days(back));
            let (w, n, _) = by_day.get(&d).copied().unwrap_or_default();
            DayStat {
                day: d,
                words: w as u32,
                dictations: n as u32,
            }
        })
        .collect();
    let (mut week_words, mut week_dictations, mut week_ms) = (0u64, 0u64, 0u64);
    for back in 0..7 {
        if let Some(&(w, n, ms)) = by_day.get(&key(today - Duration::days(back))) {
            week_words += w;
            week_dictations += n;
            week_ms += ms;
        }
    }
    // A streak still counts this morning if yesterday had a dictation.
    let active = |d: NaiveDate| by_day.get(&key(d)).is_some_and(|&(_, n, _)| n > 0);
    let mut day = if active(today) {
        today
    } else {
        today - Duration::days(1)
    };
    let mut streak_days = 0;
    while active(day) {
        streak_days += 1;
        day -= Duration::days(1);
    }
    let mut sorted: Vec<(&String, u64)> = by_day.iter().map(|(d, &(w, _, _))| (d, w)).collect();
    sorted.sort();
    let (mut running, mut milestones) = (0u64, Vec::new());
    for (d, w) in sorted {
        let before = running;
        running += w;
        for m in MILESTONES.iter().filter(|&&m| before < m && running >= m) {
            milestones.push(Milestone {
                words: *m as u32,
                day: d.clone(),
            });
        }
    }
    Ok(DictationStats {
        milestones,
        today_words: by_day.get(&key(today)).map_or(0, |&(w, _, _)| w as u32),
        week_words: week_words as u32,
        week_dictations: week_dictations as u32,
        week_minutes_saved: minutes_saved(week_words, week_ms),
        total_words: total_words as u32,
        total_dictations: total_dictations as u32,
        total_minutes_saved: minutes_saved(total_words, total_ms),
        speaking_wpm: (total_ms > 0).then(|| total_words as f64 / (total_ms as f64 / 60_000.0)),
        typing_wpm: TYPING_WPM,
        streak_days,
        days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE transcription_history (id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL,
               transcription_text TEXT NOT NULL, post_processed_text TEXT);
             CREATE TABLE daily_stats (day TEXT PRIMARY KEY, words INTEGER NOT NULL DEFAULT 0,
               dictations INTEGER NOT NULL DEFAULT 0, audio_ms INTEGER NOT NULL DEFAULT 0);",
        )
        .unwrap();
        c
    }

    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn words_are_counted_as_people_count_them() {
        assert_eq!(count_words("Merhaba, nasılsın? — iyiyim."), 3);
        assert_eq!(count_words("1. Süt\n2. Yumurta"), 4);
        assert_eq!(count_words("   "), 0);
    }

    #[test]
    fn a_week_sums_seven_days_and_time_saved_is_typing_minus_speaking() {
        let c = db();
        record(&c, "2026-10-13", 400, 3 * 60_000).unwrap(); // today: 400 words said in 3 min
        record(&c, "2026-10-13", 100, 60_000).unwrap();
        record(&c, "2026-10-08", 300, 2 * 60_000).unwrap(); // six days ago: in the week
        record(&c, "2026-10-06", 1000, 6 * 60_000).unwrap(); // eight days ago: not
        let s = summary(&c, date("2026-10-13")).unwrap();
        assert_eq!(
            (s.today_words, s.week_words, s.week_dictations),
            (500, 800, 3)
        );
        assert!((s.week_minutes_saved - (800.0 / 40.0 - 6.0)).abs() < 1e-9);
        assert_eq!((s.total_words, s.total_dictations), (1800, 4));
        assert_eq!(s.days.len(), 7);
        assert_eq!(s.days.first().unwrap().day, "2026-10-07");
        assert_eq!(
            (
                s.days.last().unwrap().day.as_str(),
                s.days.last().unwrap().words
            ),
            ("2026-10-13", 500)
        );
        assert!((s.speaking_wpm.unwrap() - 1800.0 / 12.0).abs() < 1e-9);
    }

    #[test]
    fn milestones_are_dated_by_the_day_they_were_passed() {
        let c = db();
        record(&c, "2026-10-10", 600, 0).unwrap();
        record(&c, "2026-10-11", 600, 0).unwrap(); // 1.200: passes 1.000
        record(&c, "2026-10-12", 4000, 0).unwrap(); // 5.200: passes 2.500 and 5.000
        let m = summary(&c, date("2026-10-13")).unwrap().milestones;
        assert_eq!(
            m.iter()
                .map(|x| (x.words, x.day.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (1000, "2026-10-11"),
                (2500, "2026-10-12"),
                (5000, "2026-10-12")
            ]
        );
    }

    #[test]
    fn a_streak_counts_consecutive_days_through_yesterday() {
        let c = db();
        for d in ["2026-10-10", "2026-10-11", "2026-10-12"] {
            record(&c, d, 10, 5_000).unwrap();
        }
        assert_eq!(summary(&c, date("2026-10-13")).unwrap().streak_days, 3); // nothing yet today
        record(&c, "2026-10-13", 10, 5_000).unwrap();
        assert_eq!(summary(&c, date("2026-10-13")).unwrap().streak_days, 4);
        assert_eq!(summary(&c, date("2026-10-15")).unwrap().streak_days, 0); // a day was missed
    }

    #[test]
    fn history_is_counted_once_and_time_saved_is_never_negative() {
        let c = db();
        c.execute("INSERT INTO transcription_history (timestamp, transcription_text, post_processed_text) VALUES (1791900000, 'ham metin burada', 'Düzenlenmiş metin.')", []).unwrap();
        backfill_if_empty(&c).unwrap();
        backfill_if_empty(&c).unwrap();
        let s = summary(&c, date("2026-10-13")).unwrap();
        assert_eq!((s.total_words, s.total_dictations), (2, 1)); // the pasted text, counted once
        record(&c, "2026-10-13", 1, 600_000).unwrap(); // one word in ten minutes
        assert!(summary(&c, date("2026-10-13")).unwrap().week_minutes_saved >= 0.0);
    }
}
