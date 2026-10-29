import type { HistoryEntry } from "@/bindings";

/** What was pasted: the formatted text when formatting produced one, the
 *  transcript as heard otherwise. */
export const pastedText = (e: HistoryEntry) =>
  e.post_processed_text ?? e.transcription_text;

/** The words of a text alone: lower case, no punctuation, single spaces. */
export const wordsOf = (text: string) =>
  text
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");

export const countWords = (text: string) =>
  text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** YYYY-MM-DD in local time, the key the feed groups days by. */
export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** What changed between two versions of a text, word by word: up to `max` hunks
 *  of removed and added words ("petro" -> "spero"). */
export const wordChanges = (before: string, after: string, max = 3) => {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const dp = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks: { from: string; to: string }[] = [];
  let i = 0,
    j = 0,
    from: string[] = [],
    to: string[] = [];
  const flush = () => {
    if (from.length || to.length)
      hunks.push({ from: from.join(" "), to: to.join(" ") });
    from = [];
    to = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (
      j >= b.length ||
      (i < a.length && dp[i + 1][j] >= dp[i][j + 1])
    ) {
      from.push(a[i++]);
    } else {
      to.push(b[j++]);
    }
  }
  flush();
  return hunks.slice(0, max);
};

/** Base letters of the accented ones search folds away. */
const BASES: Record<string, string> = {
  a: "àáâãäåāăą",
  c: "çćĉċč",
  d: "ďđ",
  e: "èéêëēĕėęě",
  g: "ĝğġģ",
  h: "ĥħ",
  i: "ìíîïĩīĭįı",
  j: "ĵ",
  k: "ķ",
  l: "ĺļľŀł",
  n: "ñńņň",
  o: "òóôõöøōŏő",
  r: "ŕŗř",
  s: "śŝşšș",
  t: "ţťŧț",
  u: "ùúûüũūŭůűų",
  w: "ŵ",
  y: "ýÿŷ",
  z: "źżž",
};
const BASE = new Map(
  Object.entries(BASES).flatMap(([b, all]) => [...all].map((c) => [c, b])),
);

/** One character as search compares it: lower case, accents dropped, dotted
 *  and dotless i alike. Mirrors `fold_into` in src-tauri's managers/history.rs,
 *  which finds the matches this highlights. */
const foldChar = (ch: string) =>
  [...ch.toLowerCase()]
    .filter((c) => c < "̀" || c > "ͯ")
    .map((c) => BASE.get(c) ?? c)
    .join("");

export const fold = (text: string) => [...text].map(foldChar).join("");

/** The words of a search query, folded; a dictation must hold them all. */
export const searchTerms = (query: string) => [
  ...new Set(query.split(/\s+/).map(fold).filter(Boolean)),
];

/** Where `terms` occur in `text`, as merged [start, end) ranges of `text`. */
export const matchRanges = (text: string, terms: string[]) => {
  // Each folded code unit points back at the character it came from.
  let folded = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    folded += f;
    for (let k = 0; k < f.length; k++) {
      from.push(at);
      to.push(at + ch.length);
    }
    at += ch.length;
  }
  const found: [number, number][] = [];
  for (const term of terms) {
    for (let i = folded.indexOf(term); i >= 0; i = folded.indexOf(term, i + 1))
      found.push([from[i], to[i + term.length - 1]]);
  }
  found.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push(r);
  }
  return merged;
};

/** Whether a dictation holds every term, where the backend's search looks. */
export const matchesSearch = (e: HistoryEntry, terms: string[]) => {
  const hay = fold(
    [e.post_processed_text, e.transcription_text, e.app_name]
      .filter(Boolean)
      .join("\n"),
  );
  return terms.length > 0 && terms.every((t) => hay.includes(t));
};
