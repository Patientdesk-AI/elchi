/**
 * Whether this build ships a working self-updater: Eshlik's own feed
 * (speech.patientdesk.ai/downloads/elchi/latest.json), signed with Eshlik's
 * updater key (`plugins.updater` in src-tauri/tauri.conf.json). Mirrors
 * `SELF_UPDATE_AVAILABLE` in src-tauri/src/settings.rs.
 */
export const SELF_UPDATE_AVAILABLE = true;
