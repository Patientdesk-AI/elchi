// Standalone assert check (no JS unit-test runner in this repo). Run with:
//   bun src/components/home/searchResults.test.ts
import assert from "node:assert";
import type { HistoryEntry } from "@/bindings";
import { appendFound, applyToFound, type Found } from "./searchResults";

const entry = (id: number, text: string, raw = text): HistoryEntry => ({
  id,
  file_name: `${id}.wav`,
  timestamp: id,
  saved: false,
  title: "",
  transcription_text: raw,
  post_processed_text: text,
  post_process_prompt: null,
  post_process_requested: false,
  app_name: null,
  edited_from: null,
});

const found = (q: string, entries: HistoryEntry[], more = false): Found => ({
  q,
  entries,
  hasMore: more,
  total: entries.length + (more ? 10 : 0),
});

// Editing away the only matching word drops the dictation and its count.
{
  const prev = found("alpha", [entry(7, "alpha result", "raw dictation")]);
  const next = applyToFound(prev, {
    action: "updated",
    entry: entry(7, "beta result", "raw dictation"),
  });
  assert.deepStrictEqual(next?.entries, []);
  assert.strictEqual(next?.total, 0);
}

// An edit that still matches replaces the row in place.
{
  const prev = found("alpha", [entry(9, "alpha one"), entry(7, "alpha two")]);
  const next = applyToFound(prev, {
    action: "updated",
    entry: entry(7, "alpha two, fixed"),
  });
  assert.deepStrictEqual(
    next?.entries.map((e) => e.post_processed_text),
    ["alpha one", "alpha two, fixed"],
  );
  assert.strictEqual(next?.total, 2);
}

// An edit that makes a loaded-range dictation match adds it, in id order.
{
  const prev = found("alpha", [entry(9, "alpha one"), entry(5, "alpha two")]);
  const next = applyToFound(prev, {
    action: "updated",
    entry: entry(7, "now alpha"),
  });
  assert.deepStrictEqual(
    next?.entries.map((e) => e.id),
    [9, 7, 5],
  );
  assert.strictEqual(next?.total, 3);
}

// Older than every loaded result, with more to load: the next page brings it.
{
  const prev = found("alpha", [entry(9, "alpha one")], true);
  const next = applyToFound(prev, {
    action: "updated",
    entry: entry(3, "now alpha"),
  });
  assert.strictEqual(next, prev);
}

// A new dictation that matches goes on top, once.
{
  const prev = found("alpha", [entry(9, "alpha one")]);
  const added = applyToFound(prev, {
    action: "added",
    entry: entry(12, "alpha new"),
  });
  assert.deepStrictEqual(
    added?.entries.map((e) => e.id),
    [12, 9],
  );
  const again = applyToFound(added, {
    action: "added",
    entry: entry(12, "alpha new"),
  });
  assert.strictEqual(again?.total, 2);
  assert.strictEqual(
    applyToFound(prev, { action: "added", entry: entry(13, "beta") }),
    prev,
  );
}

// An older page for a query that is no longer shown is dropped, even when
// it arrives after the new query's first page.
{
  const beta = found("beta", [entry(8, "beta one")]);
  const late = appendFound(beta, "alpha", {
    entries: [entry(4, "alpha old")],
    has_more: true,
    total: 5,
  });
  assert.strictEqual(late, beta);

  const paged = appendFound(beta, "beta", {
    entries: [entry(8, "beta one"), entry(2, "beta two")],
    has_more: false,
    total: 2,
  });
  assert.deepStrictEqual(
    paged?.entries.map((e) => e.id),
    [8, 2],
  );
  assert.strictEqual(paged?.hasMore, false);
}

console.log("searchResults: ok");
