use anyhow::{anyhow, Result};
use chrono::{DateTime, Local, Utc};
use log::{debug, error, info};
use rusqlite::{params, Connection, OptionalExtension};
use rusqlite_migration::{Migrations, M};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_specta::Event;

/// Database migrations for transcription history.
/// Each migration is applied in order. The library tracks which migrations
/// have been applied using SQLite's user_version pragma.
///
/// Note: For users upgrading from tauri-plugin-sql, migrate_from_tauri_plugin_sql()
/// converts the old _sqlx_migrations table tracking to the user_version pragma,
/// ensuring migrations don't re-run on existing databases.
static MIGRATIONS: &[M] = &[
    M::up(
        "CREATE TABLE IF NOT EXISTS transcription_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            saved BOOLEAN NOT NULL DEFAULT 0,
            title TEXT NOT NULL,
            transcription_text TEXT NOT NULL
        );",
    ),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_processed_text TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_prompt TEXT;"),
    M::up("ALTER TABLE transcription_history ADD COLUMN post_process_requested BOOLEAN NOT NULL DEFAULT 0;"),
    // Eshlik's word counts per day (managers/stats.rs).
    M::up(
        "CREATE TABLE IF NOT EXISTS daily_stats (
            day TEXT PRIMARY KEY,
            words INTEGER NOT NULL DEFAULT 0,
            dictations INTEGER NOT NULL DEFAULT 0,
            audio_ms INTEGER NOT NULL DEFAULT 0
        );",
    ),
    // The app a dictation went into (crate::frontmost), for the home feed.
    M::up("ALTER TABLE transcription_history ADD COLUMN app_name TEXT;"),
    // The text as pasted, kept when the user corrects a dictation (the feed shows the change).
    M::up("ALTER TABLE transcription_history ADD COLUMN edited_from TEXT;"),
    // Meetings (crate::meeting): one row per meeting, its transcript as speaker segments.
    M::up(
        "CREATE TABLE IF NOT EXISTS meetings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            title TEXT NOT NULL DEFAULT '',
            user_notes TEXT NOT NULL DEFAULT '',
            notes TEXT,
            status TEXT NOT NULL DEFAULT 'recording',
            kept BOOLEAN NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS meeting_segments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            speaker TEXT NOT NULL,
            start_ms INTEGER NOT NULL,
            end_ms INTEGER NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS meeting_segments_by_meeting
            ON meeting_segments (meeting_id, start_ms);",
    ),
    // A meeting shared by link (crate::meeting::share): the server's id, to stop sharing, and the link.
    M::up("ALTER TABLE meetings ADD COLUMN share_id TEXT; ALTER TABLE meetings ADD COLUMN share_url TEXT;"),
];

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct PaginatedHistory {
    pub entries: Vec<HistoryEntry>,
    pub has_more: bool,
}

/// A page of the dictations matching a search, newest first.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistorySearch {
    pub entries: Vec<HistoryEntry>,
    pub has_more: bool,
    /// Every match older than the cursor, this page included.
    pub total: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(tag = "action")]
pub enum HistoryUpdatePayload {
    #[serde(rename = "added")]
    Added { entry: HistoryEntry },
    #[serde(rename = "updated")]
    Updated { entry: HistoryEntry },
    #[serde(rename = "deleted")]
    Deleted { id: i64 },
    #[serde(rename = "toggled")]
    Toggled { id: i64 },
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct HistoryEntry {
    pub id: i64,
    pub file_name: String,
    pub timestamp: i64,
    pub saved: bool,
    pub title: String,
    pub transcription_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
    pub post_process_requested: bool,
    /// The app it was pasted into ("Mail"), when known.
    #[serde(default)]
    pub app_name: Option<String>,
    /// What was pasted, when the user has since corrected it (the text is then the correction).
    #[serde(default)]
    pub edited_from: Option<String>,
}

/// Folds text for search: lower case, accents dropped, and dotted and dotless i
/// alike, so "istanbul", "ilik" and "cagri" find "İstanbul", "ILIK" and "Çağrı".
/// Mirrored by `fold` in src/components/home/text.ts, which highlights matches.
fn fold_into(text: &str, out: &mut String) {
    for c in text.chars().flat_map(char::to_lowercase) {
        let base = match c {
            // Combining marks: "İ" lowercases to "i" + U+0307, and decomposed text carries them.
            '\u{300}'..='\u{36f}' => continue,
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
            'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
            'ď' | 'đ' => 'd',
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
            'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
            'ĥ' | 'ħ' => 'h',
            'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
            'ĵ' => 'j',
            'ķ' => 'k',
            'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
            'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
            'ŕ' | 'ŗ' | 'ř' => 'r',
            'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => 's',
            'ţ' | 'ť' | 'ŧ' | 'ț' => 't',
            'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
            'ŵ' => 'w',
            'ý' | 'ÿ' | 'ŷ' => 'y',
            'ź' | 'ż' | 'ž' => 'z',
            c => c,
        };
        out.push(base);
    }
}

fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    fold_into(text, &mut out);
    out
}

pub struct HistoryManager {
    app_handle: AppHandle,
    recordings_dir: PathBuf,
    db_path: PathBuf,
}

impl HistoryManager {
    pub fn new(app_handle: &AppHandle) -> Result<Self> {
        // Create recordings directory in app data dir
        let app_data_dir = crate::portable::app_data_dir(app_handle)?;
        let recordings_dir = app_data_dir.join("recordings");
        let db_path = app_data_dir.join("history.db");

        // Ensure recordings directory exists
        if !recordings_dir.exists() {
            fs::create_dir_all(&recordings_dir)?;
            debug!("Created recordings directory: {:?}", recordings_dir);
        }

        let manager = Self {
            app_handle: app_handle.clone(),
            recordings_dir,
            db_path,
        };

        // Initialize database and run migrations synchronously
        manager.init_database()?;

        Ok(manager)
    }

    fn init_database(&self) -> Result<()> {
        info!("Initializing database at {:?}", self.db_path);

        let mut conn = Connection::open(&self.db_path)?;

        // Handle migration from tauri-plugin-sql to rusqlite_migration
        // tauri-plugin-sql used _sqlx_migrations table, rusqlite_migration uses user_version pragma
        self.migrate_from_tauri_plugin_sql(&conn)?;

        // Create migrations object and run to latest version
        let migrations = Migrations::new(MIGRATIONS.to_vec());

        // Validate migrations in debug builds
        #[cfg(debug_assertions)]
        migrations.validate().expect("Invalid migrations");

        // Get current version before migration
        let version_before: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        debug!("Database version before migration: {}", version_before);

        // Apply any pending migrations
        migrations.to_latest(&mut conn)?;

        // Get version after migration
        let version_after: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if version_after > version_before {
            info!(
                "Database migrated from version {} to {}",
                version_before, version_after
            );
        } else {
            debug!("Database already at latest version {}", version_after);
        }

        if let Err(e) = super::stats::backfill_if_empty(&conn) {
            error!("Could not count earlier dictations for stats: {}", e);
        }

        Ok(())
    }

    /// Counts a pasted dictation in the day's stats.
    pub fn record_dictation(&self, text: &str, audio_secs: f64) {
        let words = super::stats::count_words(text);
        if words == 0 {
            return;
        }
        let day = Local::now().format("%Y-%m-%d").to_string();
        let result = self.get_connection().and_then(|c| {
            Ok(super::stats::record(
                &c,
                &day,
                words,
                (audio_secs * 1000.0) as u64,
            )?)
        });
        if let Err(e) = result {
            error!("Could not record dictation stats: {}", e);
        }
    }

    pub fn dictation_stats(&self) -> Result<super::stats::DictationStats> {
        let conn = self.get_connection()?;
        Ok(super::stats::summary(&conn, Local::now().date_naive())?)
    }

    /// Migrate from tauri-plugin-sql's migration tracking to rusqlite_migration's.
    /// tauri-plugin-sql used a _sqlx_migrations table, while rusqlite_migration uses
    /// SQLite's user_version pragma. This function checks if the old system was in use
    /// and sets the user_version accordingly so migrations don't re-run.
    fn migrate_from_tauri_plugin_sql(&self, conn: &Connection) -> Result<()> {
        // Check if the old _sqlx_migrations table exists
        let has_sqlx_migrations: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if !has_sqlx_migrations {
            return Ok(());
        }

        // Check current user_version
        let current_version: i32 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

        if current_version > 0 {
            // Already migrated to rusqlite_migration system
            return Ok(());
        }

        // Get the highest version from the old migrations table
        let old_version: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM _sqlx_migrations WHERE success = 1",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if old_version > 0 {
            info!(
                "Migrating from tauri-plugin-sql (version {}) to rusqlite_migration",
                old_version
            );

            // Set user_version to match the old migration state
            conn.pragma_update(None, "user_version", old_version)?;

            // Optionally drop the old migrations table (keeping it doesn't hurt)
            // conn.execute("DROP TABLE IF EXISTS _sqlx_migrations", [])?;

            info!(
                "Migration tracking converted: user_version set to {}",
                old_version
            );
        }

        Ok(())
    }

    fn get_connection(&self) -> Result<Connection> {
        Ok(Connection::open(&self.db_path)?)
    }

    /// The history database, for the meetings kept beside the dictations (crate::meeting).
    pub(crate) fn connection(&self) -> Result<Connection> {
        let conn = self.get_connection()?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        Ok(conn)
    }

    fn map_history_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
        Ok(HistoryEntry {
            id: row.get("id")?,
            file_name: row.get("file_name")?,
            timestamp: row.get("timestamp")?,
            saved: row.get("saved")?,
            title: row.get("title")?,
            transcription_text: row.get("transcription_text")?,
            post_processed_text: row.get("post_processed_text")?,
            post_process_prompt: row.get("post_process_prompt")?,
            post_process_requested: row.get("post_process_requested")?,
            // Absent from queries that do not ask for it, and NULL before it was recorded.
            app_name: row.get("app_name").unwrap_or(None),
            edited_from: row.get("edited_from").unwrap_or(None),
        })
    }

    pub fn recordings_dir(&self) -> &std::path::Path {
        &self.recordings_dir
    }

    /// Save a new history entry to the database.
    /// The WAV file should already have been written to the recordings directory.
    pub fn save_entry(
        &self,
        file_name: String,
        transcription_text: String,
        post_process_requested: bool,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
        app_name: Option<String>,
    ) -> Result<HistoryEntry> {
        let timestamp = Utc::now().timestamp();
        let title = self.format_timestamp_title(timestamp);

        let conn = self.get_connection()?;
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                app_name
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                &file_name,
                timestamp,
                false,
                &title,
                &transcription_text,
                &post_processed_text,
                &post_process_prompt,
                post_process_requested,
                &app_name,
            ],
        )?;

        let entry = HistoryEntry {
            id: conn.last_insert_rowid(),
            file_name,
            timestamp,
            saved: false,
            title,
            transcription_text,
            post_processed_text,
            post_process_prompt,
            post_process_requested,
            app_name,
            edited_from: None,
        };

        debug!("Saved history entry with id {}", entry.id);

        self.cleanup_old_entries()?;

        // Emit typed event for real-time frontend updates
        if let Err(e) = (HistoryUpdatePayload::Added {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(entry)
    }

    /// Update an existing history entry with new transcription results (used by retry).
    pub fn update_transcription(
        &self,
        id: i64,
        transcription_text: String,
        post_processed_text: Option<String>,
        post_process_prompt: Option<String>,
    ) -> Result<HistoryEntry> {
        let conn = self.get_connection()?;
        let updated = conn.execute(
            "UPDATE transcription_history
             SET transcription_text = ?1,
                 post_processed_text = ?2,
                 post_process_prompt = ?3
             WHERE id = ?4",
            params![
                transcription_text,
                post_processed_text,
                post_process_prompt,
                id
            ],
        )?;

        if updated == 0 {
            return Err(anyhow!("History entry {} not found", id));
        }

        let entry = conn
            .query_row(
                "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, app_name, edited_from
                 FROM transcription_history WHERE id = ?1",
                params![id],
                Self::map_history_entry,
            )?;

        debug!("Updated transcription for history entry {}", id);

        if let Err(e) = (HistoryUpdatePayload::Updated {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(entry)
    }

    /// The user's correction of a dictation: it becomes the text, and what was
    /// pasted is kept (the first time) so the change can be shown.
    pub fn correct_text(&self, id: i64, text: &str) -> Result<HistoryEntry> {
        let conn = self.get_connection()?;
        let updated = conn.execute(
            "UPDATE transcription_history
             SET edited_from = COALESCE(edited_from, post_processed_text, transcription_text),
                 post_processed_text = ?1
             WHERE id = ?2",
            params![text, id],
        )?;
        if updated == 0 {
            return Err(anyhow!("History entry {} not found", id));
        }
        let entry = conn.query_row(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, app_name, edited_from
             FROM transcription_history WHERE id = ?1",
            params![id],
            Self::map_history_entry,
        )?;
        if let Err(e) = (HistoryUpdatePayload::Updated {
            entry: entry.clone(),
        })
        .emit(&self.app_handle)
        {
            error!("Failed to emit history-updated event: {}", e);
        }
        Ok(entry)
    }

    pub fn cleanup_old_entries(&self) -> Result<()> {
        let retention_period = crate::settings::get_recording_retention_period(&self.app_handle);

        match retention_period {
            crate::settings::RecordingRetentionPeriod::Never => {
                // Don't delete anything
                Ok(())
            }
            crate::settings::RecordingRetentionPeriod::PreserveLimit => {
                // Use the old count-based logic with history_limit
                let limit = crate::settings::get_history_limit(&self.app_handle);
                self.cleanup_by_count(limit)
            }
            _ => {
                // Use time-based logic
                self.cleanup_by_time(retention_period)
            }
        }
    }

    fn delete_entries_and_files(&self, entries: &[(i64, String)]) -> Result<usize> {
        if entries.is_empty() {
            return Ok(0);
        }

        let conn = self.get_connection()?;
        let mut deleted_count = 0;

        for (id, file_name) in entries {
            // Delete database entry
            conn.execute(
                "DELETE FROM transcription_history WHERE id = ?1",
                params![id],
            )?;
            // Tell open views, which may still show the pruned entry and would
            // otherwise act on a deleted row and recording.
            if let Err(e) = (HistoryUpdatePayload::Deleted { id: *id }).emit(&self.app_handle) {
                error!("Failed to emit history-updated event: {}", e);
            }

            // Delete WAV file
            let file_path = self.recordings_dir.join(file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete WAV file {}: {}", file_name, e);
                } else {
                    debug!("Deleted old WAV file: {}", file_name);
                    deleted_count += 1;
                }
            }
        }

        Ok(deleted_count)
    }

    fn cleanup_by_count(&self, limit: usize) -> Result<()> {
        let conn = self.get_connection()?;

        // Get all entries that are not saved, ordered by timestamp desc
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history WHERE saved = 0 ORDER BY timestamp DESC"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>("id")?, row.get::<_, String>("file_name")?))
        })?;

        let mut entries: Vec<(i64, String)> = Vec::new();
        for row in rows {
            entries.push(row?);
        }

        if entries.len() > limit {
            let entries_to_delete = &entries[limit..];
            let deleted_count = self.delete_entries_and_files(entries_to_delete)?;

            if deleted_count > 0 {
                debug!("Cleaned up {} old history entries by count", deleted_count);
            }
        }

        Ok(())
    }

    fn cleanup_by_time(
        &self,
        retention_period: crate::settings::RecordingRetentionPeriod,
    ) -> Result<()> {
        let conn = self.get_connection()?;

        // Calculate cutoff timestamp (current time minus retention period)
        let now = Utc::now().timestamp();
        let cutoff_timestamp = match retention_period {
            crate::settings::RecordingRetentionPeriod::Days3 => now - (3 * 24 * 60 * 60), // 3 days in seconds
            crate::settings::RecordingRetentionPeriod::Weeks2 => now - (2 * 7 * 24 * 60 * 60), // 2 weeks in seconds
            crate::settings::RecordingRetentionPeriod::Months3 => now - (3 * 30 * 24 * 60 * 60), // 3 months in seconds (approximate)
            _ => unreachable!("Should not reach here"),
        };

        // Get all unsaved entries older than the cutoff timestamp
        let mut stmt = conn.prepare(
            "SELECT id, file_name FROM transcription_history WHERE saved = 0 AND timestamp < ?1",
        )?;

        let rows = stmt.query_map(params![cutoff_timestamp], |row| {
            Ok((row.get::<_, i64>("id")?, row.get::<_, String>("file_name")?))
        })?;

        let mut entries_to_delete: Vec<(i64, String)> = Vec::new();
        for row in rows {
            entries_to_delete.push(row?);
        }

        let deleted_count = self.delete_entries_and_files(&entries_to_delete)?;

        if deleted_count > 0 {
            debug!(
                "Cleaned up {} old history entries based on retention period",
                deleted_count
            );
        }

        Ok(())
    }

    pub async fn get_history_entries(
        &self,
        cursor: Option<i64>,
        limit: Option<usize>,
    ) -> Result<PaginatedHistory> {
        let conn = self.get_connection()?;
        let limit = limit.map(|l| l.min(100));

        let mut entries: Vec<HistoryEntry> = match (cursor, limit) {
            (Some(cursor_id), Some(lim)) => {
                let fetch_count = (lim + 1) as i64;
                let mut stmt = conn.prepare(
                    "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, app_name, edited_from
                     FROM transcription_history
                     WHERE id < ?1
                     ORDER BY id DESC
                     LIMIT ?2",
                )?;
                let result = stmt
                    .query_map(params![cursor_id, fetch_count], Self::map_history_entry)?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                result
            }
            (None, Some(lim)) => {
                let fetch_count = (lim + 1) as i64;
                let mut stmt = conn.prepare(
                    "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, app_name, edited_from
                     FROM transcription_history
                     ORDER BY id DESC
                     LIMIT ?1",
                )?;
                let result = stmt
                    .query_map(params![fetch_count], Self::map_history_entry)?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                result
            }
            (_, None) => {
                let mut stmt = conn.prepare(
                    "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, app_name, edited_from
                     FROM transcription_history
                     ORDER BY id DESC",
                )?;
                let result = stmt
                    .query_map([], Self::map_history_entry)?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                result
            }
        };

        let has_more = limit.is_some_and(|lim| entries.len() > lim);
        if has_more {
            entries.pop();
        }

        Ok(PaginatedHistory { entries, has_more })
    }

    /// Dictations holding every word of `query` (folded, see `fold_into`) in
    /// their text as shown, the transcript as heard or the app's name; newest
    /// first and paged like get_history_entries.
    pub async fn search_history_entries(
        &self,
        query: &str,
        cursor: Option<i64>,
        limit: Option<usize>,
    ) -> Result<HistorySearch> {
        let conn = self.get_connection()?;
        Self::search_with_conn(&conn, query, cursor, limit)
    }

    // A scan folded in Rust: SQLite's LIKE and lower() only fold ASCII. It
    // reads every older row to count the matches: ~30 ms for 50k in a release build.
    fn search_with_conn(
        conn: &Connection,
        query: &str,
        cursor: Option<i64>,
        limit: Option<usize>,
    ) -> Result<HistorySearch> {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(fold)
            .filter(|t| !t.is_empty())
            .collect();
        let limit = limit.map(|l| l.min(100));
        let mut entries = Vec::new();
        let mut total = 0u32;
        if terms.is_empty() {
            return Ok(HistorySearch {
                entries,
                has_more: false,
                total,
            });
        }

        let mut stmt = conn.prepare(
            "SELECT id, file_name, timestamp, saved, title, transcription_text, post_processed_text, post_process_prompt, post_process_requested, app_name, edited_from
             FROM transcription_history
             WHERE id < ?1
             ORDER BY id DESC",
        )?;
        let mut rows = stmt.query(params![cursor.unwrap_or(i64::MAX)])?;
        let mut haystack = String::new();
        while let Some(row) = rows.next()? {
            haystack.clear();
            // The shown text is the post-processed one (an edit is saved there) or the transcript.
            for column in ["post_processed_text", "transcription_text", "app_name"] {
                if let rusqlite::types::ValueRef::Text(t) = row.get_ref(column)? {
                    fold_into(&String::from_utf8_lossy(t), &mut haystack);
                    haystack.push('\n');
                }
            }
            if terms.iter().all(|t| haystack.contains(t.as_str())) {
                total += 1;
                if limit.is_none_or(|lim| entries.len() < lim) {
                    entries.push(Self::map_history_entry(row)?);
                }
            }
        }

        Ok(HistorySearch {
            has_more: total as usize > entries.len(),
            entries,
            total,
        })
    }

    #[cfg(test)]
    fn get_latest_entry_with_conn(conn: &Connection) -> Result<Option<HistoryEntry>> {
        let mut stmt = conn.prepare(
            "SELECT
                id,
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested
             FROM transcription_history
             ORDER BY timestamp DESC
             LIMIT 1",
        )?;

        let entry = stmt.query_row([], Self::map_history_entry).optional()?;
        Ok(entry)
    }

    /// Get the latest entry with non-empty transcription text.
    pub fn get_latest_completed_entry(&self) -> Result<Option<HistoryEntry>> {
        let conn = self.get_connection()?;
        Self::get_latest_completed_entry_with_conn(&conn)
    }

    fn get_latest_completed_entry_with_conn(conn: &Connection) -> Result<Option<HistoryEntry>> {
        let mut stmt = conn.prepare(
            "SELECT
                id,
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested
             FROM transcription_history
             WHERE transcription_text != ''
             ORDER BY timestamp DESC
             LIMIT 1",
        )?;

        let entry = stmt.query_row([], Self::map_history_entry).optional()?;
        Ok(entry)
    }

    pub async fn toggle_saved_status(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get current saved status
        let current_saved: bool = conn.query_row(
            "SELECT saved FROM transcription_history WHERE id = ?1",
            params![id],
            |row| row.get("saved"),
        )?;

        let new_saved = !current_saved;

        conn.execute(
            "UPDATE transcription_history SET saved = ?1 WHERE id = ?2",
            params![new_saved, id],
        )?;

        debug!("Toggled saved status for entry {}: {}", id, new_saved);

        // Emit history updated event
        if let Err(e) = (HistoryUpdatePayload::Toggled { id }).emit(&self.app_handle) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    pub fn get_audio_file_path(&self, file_name: &str) -> PathBuf {
        self.recordings_dir.join(file_name)
    }

    pub async fn get_entry_by_id(&self, id: i64) -> Result<Option<HistoryEntry>> {
        let conn = self.get_connection()?;
        let mut stmt = conn.prepare(
            "SELECT
                id,
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested,
                app_name,
                edited_from
             FROM transcription_history
             WHERE id = ?1",
        )?;

        let entry = stmt.query_row([id], Self::map_history_entry).optional()?;

        Ok(entry)
    }

    pub async fn delete_entry(&self, id: i64) -> Result<()> {
        let conn = self.get_connection()?;

        // Get the entry to find the file name
        if let Some(entry) = self.get_entry_by_id(id).await? {
            // Delete the audio file first
            let file_path = self.get_audio_file_path(&entry.file_name);
            if file_path.exists() {
                if let Err(e) = fs::remove_file(&file_path) {
                    error!("Failed to delete audio file {}: {}", entry.file_name, e);
                    // Continue with database deletion even if file deletion fails
                }
            }
        }

        // Delete from database
        conn.execute(
            "DELETE FROM transcription_history WHERE id = ?1",
            params![id],
        )?;

        debug!("Deleted history entry with id: {}", id);

        // Emit history updated event
        if let Err(e) = (HistoryUpdatePayload::Deleted { id }).emit(&self.app_handle) {
            error!("Failed to emit history-updated event: {}", e);
        }

        Ok(())
    }

    fn format_timestamp_title(&self, timestamp: i64) -> String {
        if let Some(utc_datetime) = DateTime::from_timestamp(timestamp, 0) {
            // Convert UTC to local timezone
            let local_datetime = utc_datetime.with_timezone(&Local);
            local_datetime.format("%B %e, %Y - %l:%M%p").to_string()
        } else {
            format!("Recording {}", timestamp)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        conn.execute_batch(
            "CREATE TABLE transcription_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_name TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                saved BOOLEAN NOT NULL DEFAULT 0,
                title TEXT NOT NULL,
                transcription_text TEXT NOT NULL,
                post_processed_text TEXT,
                post_process_prompt TEXT,
                post_process_requested BOOLEAN NOT NULL DEFAULT 0
            );",
        )
        .expect("create transcription_history table");
        conn
    }

    fn insert_entry(conn: &Connection, timestamp: i64, text: &str, post_processed: Option<&str>) {
        conn.execute(
            "INSERT INTO transcription_history (
                file_name,
                timestamp,
                saved,
                title,
                transcription_text,
                post_processed_text,
                post_process_prompt,
                post_process_requested
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                format!("handy-{}.wav", timestamp),
                timestamp,
                false,
                format!("Recording {}", timestamp),
                text,
                post_processed,
                Option::<String>::None,
                false,
            ],
        )
        .expect("insert history entry");
    }

    #[test]
    fn get_latest_entry_returns_none_when_empty() {
        let conn = setup_conn();
        let entry = HistoryManager::get_latest_entry_with_conn(&conn).expect("fetch latest entry");
        assert!(entry.is_none());
    }

    #[test]
    fn get_latest_entry_returns_newest_entry() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "first", None);
        insert_entry(&conn, 200, "second", Some("processed"));

        let entry = HistoryManager::get_latest_entry_with_conn(&conn)
            .expect("fetch latest entry")
            .expect("entry exists");

        assert_eq!(entry.timestamp, 200);
        assert_eq!(entry.transcription_text, "second");
        assert_eq!(entry.post_processed_text.as_deref(), Some("processed"));
    }

    #[test]
    fn get_latest_completed_entry_skips_empty_entries() {
        let conn = setup_conn();
        insert_entry(&conn, 100, "completed", None);
        insert_entry(&conn, 200, "", None);

        let entry = HistoryManager::get_latest_completed_entry_with_conn(&conn)
            .expect("fetch latest completed entry")
            .expect("completed entry exists");

        assert_eq!(entry.timestamp, 100);
        assert_eq!(entry.transcription_text, "completed");
    }

    /// The real schema, migrations and all.
    fn migrated_conn() -> Connection {
        let mut conn = Connection::open_in_memory().expect("open in-memory db");
        Migrations::new(MIGRATIONS.to_vec())
            .to_latest(&mut conn)
            .expect("migrate");
        conn
    }

    fn insert_dictation(conn: &Connection, text: &str, processed: Option<&str>, app: Option<&str>) {
        conn.execute(
            "INSERT INTO transcription_history (file_name, timestamp, title, transcription_text, post_processed_text, app_name)
             VALUES ('a.wav', 0, '', ?1, ?2, ?3)",
            params![text, processed, app],
        )
        .expect("insert dictation");
    }

    fn search_ids(conn: &Connection, query: &str) -> Vec<i64> {
        HistoryManager::search_with_conn(conn, query, None, Some(40))
            .expect("search")
            .entries
            .iter()
            .map(|e| e.id)
            .collect()
    }

    #[test]
    fn fold_handles_turkish_case_and_accents() {
        assert_eq!(fold("İstanbul"), "istanbul");
        assert_eq!(fold("ILIK"), "ilik");
        assert_eq!(fold("ılık"), "ilik");
        assert_eq!(fold("Çağrı"), "cagri");
        assert_eq!(fold("çağrı"), "cagri");
        assert_eq!(fold("ŞÖYLE ÜZGÜN"), "soyle uzgun");
        // Decomposed "c" + cedilla, as some apps paste it.
        assert_eq!(fold("c\u{327}ay"), "cay");
        assert_eq!(fold("Crème Brûlée"), "creme brulee");
    }

    #[test]
    fn search_matches_shown_text_transcript_and_app() {
        let conn = migrated_conn();
        insert_dictation(&conn, "istanbul'a gidiyorum", None, Some("Mail")); // 1
        insert_dictation(&conn, "raw words", Some("ILIK bir gün"), Some("Slack")); // 2
        insert_dictation(&conn, "Çağrı'yı ara", None, None); // 3
        insert_dictation(&conn, "nothing here", None, Some("Notes")); // 4

        assert_eq!(search_ids(&conn, "İSTANBUL"), vec![1]);
        assert_eq!(search_ids(&conn, "ılık"), vec![2]);
        assert_eq!(search_ids(&conn, "raw"), vec![2]);
        assert_eq!(search_ids(&conn, "çağrı"), vec![3]);
        assert_eq!(search_ids(&conn, "cagri"), vec![3]);
        assert_eq!(search_ids(&conn, "slack"), vec![2]);
        // Every word must match, in any field; newest first.
        assert_eq!(search_ids(&conn, "notes nothing"), vec![4]);
        assert_eq!(search_ids(&conn, "notes ılık"), Vec::<i64>::new());
        assert_eq!(search_ids(&conn, "i"), vec![4, 3, 2, 1]);
        assert_eq!(search_ids(&conn, "   "), Vec::<i64>::new());
    }

    #[test]
    fn search_takes_percent_and_underscore_literally() {
        let conn = migrated_conn();
        insert_dictation(&conn, "yüzde 50% indirim", None, None); // 1
        insert_dictation(&conn, "file_name here", None, None); // 2
        insert_dictation(&conn, "filexname 50 percent", None, None); // 3

        assert_eq!(search_ids(&conn, "50%"), vec![1]);
        assert_eq!(search_ids(&conn, "%"), vec![1]);
        assert_eq!(search_ids(&conn, "file_name"), vec![2]);
        assert_eq!(search_ids(&conn, "_"), vec![2]);
    }

    #[test]
    fn search_pages_from_the_cursor() {
        let conn = migrated_conn();
        for i in 0..5 {
            insert_dictation(&conn, &format!("not {i}"), None, None);
            insert_dictation(&conn, &format!("toplantı {i}"), None, None);
        }
        let first = HistoryManager::search_with_conn(&conn, "TOPLANTI", None, Some(2)).unwrap();
        assert_eq!(
            first.entries.iter().map(|e| e.id).collect::<Vec<_>>(),
            vec![10, 8]
        );
        assert!(first.has_more);
        assert_eq!(first.total, 5);
        let next = HistoryManager::search_with_conn(&conn, "toplanti", Some(8), Some(2)).unwrap();
        assert_eq!(
            next.entries.iter().map(|e| e.id).collect::<Vec<_>>(),
            vec![6, 4]
        );
        assert!(next.has_more);
        assert_eq!(next.total, 3);
        let last = HistoryManager::search_with_conn(&conn, "toplanti", Some(4), Some(2)).unwrap();
        assert_eq!(
            last.entries.iter().map(|e| e.id).collect::<Vec<_>>(),
            vec![2]
        );
        assert!(!last.has_more);
    }

    #[test]
    fn search_scans_50k_dictations_quickly() {
        let mut conn = migrated_conn();
        let tx = conn.transaction().unwrap();
        for i in 0..50_000 {
            insert_dictation(
                &tx,
                &format!("Bugün İstanbul'da hava çok güzel, toplantı saat {i}'de başlıyor ve herkes gelecek."),
                Some(&format!("Bugün İstanbul'da hava çok güzel. Toplantı saat {i}'de başlıyor, herkes gelecek.")),
                Some("Slack"),
            );
        }
        tx.commit().unwrap();

        let start = std::time::Instant::now();
        let r = HistoryManager::search_with_conn(&conn, "Ankara", None, Some(40)).unwrap();
        let none = start.elapsed();
        let start = std::time::Instant::now();
        let all = HistoryManager::search_with_conn(&conn, "istanbul", None, Some(40)).unwrap();
        let every = start.elapsed();
        println!("50k rows: no match {none:?}, all match {every:?}");
        assert_eq!(r.total, 0);
        assert_eq!(all.total, 50_000);
        assert_eq!(all.entries.len(), 40);
        // Generous, for unoptimized test builds on slow CI machines.
        assert!(none.as_millis() < 3000 && every.as_millis() < 3000);
    }
}
