// Mounts the real HomeFeed outside Tauri for tests/home-feed-search.spec.ts, over
// 100 fake dictations: even ids say "alpha", multiples of 3 say "beta", id 50
// also says "zebra". Every command call is logged in `window.feed.calls`. With
// `window.feed.hold` set, searches wait in `window.feed.pending` until the test
// answers them, in whatever order it likes.
import React from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import i18n from "@/i18n";
import "@/App.css";
import type {
  HistoryEntry,
  HistorySearch,
  HistoryUpdatePayload,
} from "@/bindings";
import { HomeFeed } from "@/components/home/HomeFeed";

type Call = { cmd: string; args: Record<string, unknown> };
type Pending = {
  query: string;
  cursor: number | null;
  answer: () => void;
};

declare global {
  interface Window {
    __TAURI_OS_PLUGIN_INTERNALS__: Record<string, string>;
    feed: {
      calls: Call[];
      hold: boolean;
      pending: Pending[];
      answer: (query: string, cursor: number | null) => boolean;
      emitHistory: (p: HistoryUpdatePayload) => Promise<void>;
    };
  }
}

const text = (id: number) =>
  [
    id % 2 === 0 ? "alpha" : "",
    id % 3 === 0 ? "beta" : "",
    id === 50 ? "zebra" : "",
    `note ${id}`,
  ]
    .filter(Boolean)
    .join(" ");

const entry = (id: number): HistoryEntry => ({
  id,
  file_name: `${id}.wav`,
  timestamp: 1_700_000_000 + id * 60,
  saved: false,
  title: "",
  transcription_text: text(id),
  post_processed_text: null,
  post_process_prompt: null,
  post_process_requested: false,
  app_name: null,
  edited_from: null,
});

const ENTRIES = Array.from({ length: 100 }, (_, i) => entry(100 - i));

const shown = (e: HistoryEntry) =>
  `${e.post_processed_text ?? e.transcription_text}`.toLowerCase();

const search = (
  query: string,
  cursor: number | null,
  limit: number,
): HistorySearch => {
  const words = query.split(" ");
  const hits = ENTRIES.filter(
    (e) =>
      e.id < (cursor ?? Infinity) && words.every((w) => shown(e).includes(w)),
  );
  return {
    entries: hits.slice(0, limit),
    has_more: hits.length > limit,
    total: hits.length,
  };
};

window.__TAURI_OS_PLUGIN_INTERNALS__ = {
  os_type: "macos",
  platform: "macos",
  family: "unix",
  arch: "aarch64",
  version: "15.0",
  eol: "\n",
  exe_extension: "",
};

window.feed = {
  calls: [],
  hold: false,
  pending: [],
  answer(query, cursor) {
    const at = this.pending.findIndex(
      (p) => p.query === query && p.cursor === cursor,
    );
    if (at < 0) return false;
    this.pending.splice(at, 1)[0].answer();
    return true;
  },
  emitHistory: (p) => emit("history-update-payload", p),
};

mockIPC(
  (cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    window.feed.calls.push({ cmd, args });
    switch (cmd) {
      case "get_history_entries": {
        const cursor = (args.cursor as number | null) ?? Infinity;
        const limit = (args.limit as number | null) ?? 40;
        const older = ENTRIES.filter((e) => e.id < cursor);
        return {
          entries: older.slice(0, limit),
          has_more: older.length > limit,
        };
      }
      case "search_history_entries": {
        const query = args.query as string;
        const cursor = (args.cursor as number | null) ?? null;
        const result = search(query, cursor, (args.limit as number) ?? 40);
        if (!window.feed.hold) return result;
        return new Promise((resolve) =>
          window.feed.pending.push({
            query,
            cursor,
            answer: () => resolve(result),
          }),
        );
      }
      case "get_dictionary":
        return [];
      case "get_app_icons":
        return {};
      case "get_elchi_pro_status":
        return null;
      default:
        throw new Error(`not mocked: ${cmd}`);
    }
  },
  { shouldMockEvents: true },
);

i18n.changeLanguage("en").then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <HomeFeed onOpenSettings={() => {}} />,
  );
});
