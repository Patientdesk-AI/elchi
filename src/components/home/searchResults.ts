import type {
  HistoryEntry,
  HistorySearch,
  HistoryUpdatePayload,
} from "@/bindings";
import { matchesSearch } from "./text";

/** A page of search results: `q` is the folded words they were found for. */
export type Found = {
  q: string;
  entries: HistoryEntry[];
  hasMore: boolean;
  total: number;
};

/** Puts `entry` among `entries`, newest (highest id) first, as the backend orders them. */
const insertById = (entries: HistoryEntry[], entry: HistoryEntry) => {
  const at = entries.findIndex((e) => e.id < entry.id);
  return at < 0
    ? [...entries, entry]
    : [...entries.slice(0, at), entry, ...entries.slice(at)];
};

/**
 * A history change applied to the search results, as the feed applies it. An
 * added or edited dictation joins or leaves the results by whether it still
 * matches, so editing away the searched word drops it from them.
 */
export const applyToFound = (
  prev: Found | null,
  p: HistoryUpdatePayload,
): Found | null => {
  if (!prev) return prev;
  switch (p.action) {
    case "added":
    case "updated": {
      const had = prev.entries.some((e) => e.id === p.entry.id);
      const fits = matchesSearch(p.entry, prev.q.split(" "));
      if (had)
        return fits
          ? {
              ...prev,
              entries: prev.entries.map((e) =>
                e.id === p.entry.id ? p.entry : e,
              ),
            }
          : {
              ...prev,
              entries: prev.entries.filter((e) => e.id !== p.entry.id),
              total: prev.total - 1,
            };
      if (!fits) return prev;
      // Older than every loaded result: it is not known whether the total
      // already counts it, and the next page will bring it as it is now.
      const last = prev.entries[prev.entries.length - 1];
      if (prev.hasMore && last && p.entry.id < last.id) return prev;
      return {
        ...prev,
        entries: insertById(prev.entries, p.entry),
        total: prev.total + 1,
      };
    }
    case "deleted":
      return prev.entries.some((e) => e.id === p.id)
        ? {
            ...prev,
            entries: prev.entries.filter((e) => e.id !== p.id),
            total: prev.total - 1,
          }
        : prev;
    case "toggled":
      return {
        ...prev,
        entries: prev.entries.map((e) =>
          e.id === p.id ? { ...e, saved: !e.saved } : e,
        ),
      };
  }
};

/**
 * An older page of results for `q`, appended. Dropped when the results now
 * shown are for another query: the page arrived after the query changed.
 */
export const appendFound = (
  prev: Found | null,
  q: string,
  page: HistorySearch,
): Found | null => {
  if (!prev || prev.q !== q) return prev;
  const have = new Set(prev.entries.map((e) => e.id));
  return {
    ...prev,
    entries: [...prev.entries, ...page.entries.filter((e) => !have.has(e.id))],
    hasMore: page.has_more,
  };
};
