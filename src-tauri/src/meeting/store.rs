//! Meetings in the history database (tables made by a migration in managers/history.rs).
//!
//! A meeting's status: `recording`, then `processing` while its notes are written, then
//! `done` (notes written), `no_notes` (no Duyu Pro, or the notes failed: the transcript is
//! kept instead), `empty` (nobody spoke) or `interrupted` (Eshlik quit mid-meeting).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
pub struct Meeting {
    pub id: i64,
    /// Unix seconds.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    /// The notes' own title; empty until they are written.
    pub title: String,
    /// What the user typed during the meeting.
    pub user_notes: String,
    /// Markdown.
    pub notes: Option<String>,
    pub status: String,
    /// The audio and full transcript are kept ("keep recordings" was on).
    pub kept: bool,
    pub has_transcript: bool,
    /// The link the meeting is shared at, while it is.
    pub share_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, PartialEq)]
pub struct Segment {
    pub id: i64,
    /// `me` (the microphone) or `them` (the call's audio).
    pub speaker: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

const COLUMNS: &str = "id, started_at, ended_at, title, user_notes, notes, status, kept,
    EXISTS (SELECT 1 FROM meeting_segments s WHERE s.meeting_id = meetings.id) AS has_transcript,
    share_url";

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: r.get(0)?,
        started_at: r.get(1)?,
        ended_at: r.get(2)?,
        title: r.get(3)?,
        user_notes: r.get(4)?,
        notes: r.get(5)?,
        status: r.get(6)?,
        kept: r.get(7)?,
        has_transcript: r.get(8)?,
        share_url: r.get(9)?,
    })
}

pub fn create(conn: &Connection, started_at: i64, kept: bool) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO meetings (started_at, kept) VALUES (?1, ?2)",
        params![started_at, kept],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Meeting>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM meetings WHERE id = ?1"),
        [id],
        row,
    )
    .optional()
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Meeting>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM meetings ORDER BY started_at DESC"
    ))?;
    let rows = stmt.query_map([], row)?;
    rows.collect()
}

pub fn add_segment(
    conn: &Connection,
    meeting_id: i64,
    speaker: &str,
    start_ms: i64,
    end_ms: i64,
    text: &str,
) -> rusqlite::Result<Segment> {
    conn.execute(
        "INSERT INTO meeting_segments (meeting_id, speaker, start_ms, end_ms, text)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![meeting_id, speaker, start_ms, end_ms, text],
    )?;
    Ok(Segment {
        id: conn.last_insert_rowid(),
        speaker: speaker.to_string(),
        start_ms,
        end_ms,
        text: text.to_string(),
    })
}

pub fn segments(conn: &Connection, meeting_id: i64) -> rusqlite::Result<Vec<Segment>> {
    let mut stmt = conn.prepare(
        "SELECT id, speaker, start_ms, end_ms, text FROM meeting_segments
         WHERE meeting_id = ?1 ORDER BY start_ms, CASE speaker WHEN 'them' THEN 0 ELSE 1 END, id",
    )?;
    let rows = stmt.query_map([meeting_id], |r| {
        Ok(Segment {
            id: r.get(0)?,
            speaker: r.get(1)?,
            start_ms: r.get(2)?,
            end_ms: r.get(3)?,
            text: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn set_user_notes(conn: &Connection, id: i64, text: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE meetings SET user_notes = ?2 WHERE id = ?1",
        params![id, text],
    )?;
    Ok(())
}

pub fn set_title(conn: &Connection, id: i64, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE meetings SET title = ?2 WHERE id = ?1",
        params![id, title],
    )?;
    Ok(())
}

/// The notes as the user changed them (a to-do ticked), keeping the status.
pub fn update_notes(conn: &Connection, id: i64, notes: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE meetings SET notes = ?2 WHERE id = ?1",
        params![id, notes],
    )?;
    Ok(())
}

pub fn set_status(conn: &Connection, id: i64, status: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE meetings SET status = ?2 WHERE id = ?1",
        params![id, status],
    )?;
    Ok(())
}

pub fn end(conn: &Connection, id: i64, ended_at: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE meetings SET ended_at = ?2, status = 'processing' WHERE id = ?1",
        params![id, ended_at],
    )?;
    Ok(())
}

pub fn set_notes(conn: &Connection, id: i64, title: &str, notes: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE meetings SET title = ?2, notes = ?3, status = 'done' WHERE id = ?1",
        params![id, title, notes],
    )?;
    Ok(())
}

/// The server's id for the meeting's share, while it is shared.
pub fn share_id(conn: &Connection, id: i64) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT share_id FROM meetings WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .optional()
    .map(Option::flatten)
}

/// Marks the meeting shared at `share` (id, link), or no longer shared.
pub fn set_share(conn: &Connection, id: i64, share: Option<(&str, &str)>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE meetings SET share_id = ?2, share_url = ?3 WHERE id = ?1",
        params![id, share.map(|s| s.0), share.map(|s| s.1)],
    )?;
    Ok(())
}

/// Deletes the full transcript, leaving the notes.
pub fn drop_transcript(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM meeting_segments WHERE meeting_id = ?1", [id])?;
    Ok(())
}

/// One line of a transcript (the microphone's, when it turned out to be the call's echo).
pub fn delete_segment(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM meeting_segments WHERE id = ?1", [id])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM meeting_segments WHERE meeting_id = ?1", [id])?;
    conn.execute("DELETE FROM meetings WHERE id = ?1", [id])?;
    Ok(())
}

/// Meetings Eshlik was recording or writing up when it quit: their transcript stays.
pub fn mark_interrupted(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE meetings SET status = 'interrupted', ended_at = COALESCE(ended_at, started_at)
         WHERE status IN ('recording', 'processing')",
        [],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, started_at INTEGER NOT NULL,
               ended_at INTEGER, title TEXT NOT NULL DEFAULT '', user_notes TEXT NOT NULL DEFAULT '',
               notes TEXT, status TEXT NOT NULL DEFAULT 'recording', kept BOOLEAN NOT NULL DEFAULT 0,
               share_id TEXT, share_url TEXT);
             CREATE TABLE meeting_segments (id INTEGER PRIMARY KEY AUTOINCREMENT,
               meeting_id INTEGER NOT NULL, speaker TEXT NOT NULL, start_ms INTEGER NOT NULL,
               end_ms INTEGER NOT NULL, text TEXT NOT NULL);",
        )
        .unwrap();
        c
    }

    #[test]
    fn a_meeting_is_recorded_written_up_and_its_transcript_dropped() {
        let c = db();
        let id = create(&c, 1_800_000_000, false).unwrap();
        add_segment(&c, id, "me", 20_000, 40_000, "Cuma teslim edelim.").unwrap();
        add_segment(&c, id, "them", 20_000, 40_000, "Olur.").unwrap();
        add_segment(&c, id, "me", 0, 20_000, "Merhaba.").unwrap();
        let s = segments(&c, id).unwrap();
        // In time order, and in one window the others before the reply.
        assert_eq!(
            s.iter().map(|x| x.text.as_str()).collect::<Vec<_>>(),
            vec!["Merhaba.", "Olur.", "Cuma teslim edelim."]
        );
        set_user_notes(&c, id, "teslim?").unwrap();
        end(&c, id, 1_800_000_600).unwrap();
        assert_eq!(get(&c, id).unwrap().unwrap().status, "processing");
        set_notes(&c, id, "Plan", "- Cuma").unwrap();
        drop_transcript(&c, id).unwrap();
        let m = get(&c, id).unwrap().unwrap();
        assert_eq!(
            (m.status.as_str(), m.title.as_str(), m.has_transcript),
            ("done", "Plan", false)
        );
        assert_eq!(m.user_notes, "teslim?");
    }

    #[test]
    fn a_shared_meeting_remembers_its_link_until_it_is_stopped() {
        let c = db();
        let id = create(&c, 10, false).unwrap();
        assert_eq!(share_id(&c, id).unwrap(), None);
        set_share(&c, id, Some(("abc", "https://elchi.xyz/abc"))).unwrap();
        assert_eq!(share_id(&c, id).unwrap().as_deref(), Some("abc"));
        assert_eq!(
            get(&c, id).unwrap().unwrap().share_url.as_deref(),
            Some("https://elchi.xyz/abc")
        );
        set_share(&c, id, None).unwrap();
        assert_eq!(share_id(&c, id).unwrap(), None);
        assert_eq!(get(&c, id).unwrap().unwrap().share_url, None);
        assert_eq!(share_id(&c, 999).unwrap(), None);
    }

    #[test]
    fn meetings_cut_short_are_marked_and_keep_their_transcript() {
        let c = db();
        let a = create(&c, 10, true).unwrap();
        add_segment(&c, a, "them", 0, 1000, "x").unwrap();
        let b = create(&c, 20, false).unwrap();
        set_notes(&c, b, "", "-").unwrap();
        assert_eq!(mark_interrupted(&c).unwrap(), 1);
        let list = list(&c).unwrap();
        assert_eq!(list[0].id, b);
        assert_eq!(
            (
                list[1].status.as_str(),
                list[1].has_transcript,
                list[1].ended_at
            ),
            ("interrupted", true, Some(10))
        );
        delete(&c, a).unwrap();
        assert!(get(&c, a).unwrap().is_none() && segments(&c, a).unwrap().is_empty());
    }
}
