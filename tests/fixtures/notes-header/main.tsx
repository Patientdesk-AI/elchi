// Mounts the real NotesHeader outside Tauri for tests/notes-header.spec.ts.
// Query: ?shared (the meeting has a public link), ?noShare (the Paylaş button is
// hidden, as while its notes are being rewritten).
import React from "react";
import ReactDOM from "react-dom/client";
import i18n from "@/i18n";
import { NotesHeader } from "@/components/meetings/NotesHeader";

declare global {
  interface Window {
    deleted?: boolean;
  }
}

const query = new URLSearchParams(location.search);

i18n.changeLanguage("en").then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <NotesHeader
      back="Meetings"
      onBack={() => {}}
      title="Sprint planning"
      meta=""
      titleShown
      shared={query.has("shared")}
      share={
        query.has("noShare") ? undefined : { pro: true, onShare: () => {} }
      }
      transcript={{ shown: false, count: 8, onToggle: () => {} }}
      recordingPath={null}
      onDelete={() => {
        window.deleted = true;
      }}
    />,
  );
});
