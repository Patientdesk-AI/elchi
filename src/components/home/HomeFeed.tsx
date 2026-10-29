import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import {
  commands,
  events,
  type DictationStats,
  type DictionaryWord,
  type HistoryEntry,
} from "@/bindings";
import { daysLeft, useElchiPro } from "@/hooks/useElchiPro";
import { useSettings } from "@/hooks/useSettings";
import { useOsType } from "@/hooks/useOsType";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import type { SidebarSection } from "../Sidebar";
import { DictationRow } from "./DictationRow";
import { ChipButton, ElchiPost, GhostButton } from "./FeedRow";
import { SearchButton, SearchField } from "./FeedSearch";
import { TopBar } from "./TopBar";
import { UpsellCard } from "./UpsellCard";
import { EmptyHero, WeekHero } from "./WeekHero";
import { appendFound, applyToFound, type Found } from "./searchResults";
import { dayKey, pastedText, searchTerms } from "./text";
import { useIsDark } from "./useIsDark";

/** Dictations fetched per page; scrolling to the end fetches the next. */
const PAGE = 40;

/** Remembers "don't show again" on the trial post, for that trial only. */
const TRIAL_POST_KEY = "elchi.home.trialPostDismissed";

const readDismissed = () => {
  try {
    return localStorage.getItem(TRIAL_POST_KEY);
  } catch {
    return null;
  }
};

type Item =
  | { kind: "dictation"; at: number; entry: HistoryEntry }
  | { kind: "learned"; at: number; word: DictionaryWord }
  | { kind: "streak"; at: number; days: number }
  | { kind: "milestone"; at: number; words: number };

const DayHeader: React.FC<{
  children: React.ReactNode;
  aside?: React.ReactNode;
}> = ({ children, aside }) => (
  <div className="flex items-center gap-3 pt-[26px] pb-2.5">
    <h2 className="flex-1 min-w-0 font-mono text-[10px] tracking-[0.12em] uppercase font-normal text-text/40">
      {children}
    </h2>
    {aside}
  </div>
);

/**
 * Elchi's home: this week up top, then everything you dictated, newest
 * first and grouped by day, each from the app it went into, with Elchi's
 * own posts in between (words it learned, streaks, milestones, the trial).
 * History lives here too: hover a dictation to copy, fix, add a word to the
 * dictionary or play its recording; older ones load as you scroll.
 */
export const HomeFeed: React.FC<{
  onOpenSettings: (section?: SidebarSection) => void;
  onOpenMeetings?: () => void;
}> = ({ onOpenSettings, onOpenMeetings }) => {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { status, upgrade } = useElchiPro();
  const { settings } = useSettings();
  const osType = useOsType();
  const dark = useIsDark();
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // An older page failed to load: scrolling stops fetching until the user
  // asks again, so a persistent error can't loop requests.
  const [moreFailed, setMoreFailed] = useState(false);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<DictationStats | null>(null);
  const [dictionary, setDictionary] = useState<DictionaryWord[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [dismissedTrial, setDismissedTrial] = useState(readDismissed);
  const entriesRef = useRef<HistoryEntry[] | null>(null);
  const loadingMoreRef = useRef(false);
  // The "load older" rows, kept in state: each remounts as a new element
  // (searching swaps one for the other), and its scroll observer must follow.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const [foundSentinel, setFoundSentinel] = useState<HTMLDivElement | null>(
    null,
  );
  // Search: the query while the field is open (null when closed), and the
  // results the backend found for it.
  const [query, setQuery] = useState<string | null>(null);
  const [found, setFound] = useState<Found | null>(null);
  const [foundLoading, setFoundLoading] = useState(false);
  const [foundFailed, setFoundFailed] = useState(false);
  const foundRef = useRef<Found | null>(null);
  const foundLoadingRef = useRef(false);
  // Bumped on every new query, so answers to older ones are dropped.
  const searchSeq = useRef(0);
  // The folded words being searched for now, for callbacks that outlive a query.
  const termsRef = useRef("");
  const mainRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Where the feed was scrolled when the search opened, restored on close.
  const feedScroll = useRef<number | null>(null);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    foundRef.current = found;
  }, [found]);

  const refreshStats = useCallback(() => {
    commands.getDictationStats().then((r) => {
      if (r.status === "ok") setStats(r.data);
    });
    setNow(Date.now());
  }, []);

  // The newest page, merged over whatever older pages are already loaded.
  const refresh = useCallback(() => {
    commands.getHistoryEntries(null, PAGE).then((r) => {
      if (r.status !== "ok") return;
      const first = r.data.entries;
      const prev = entriesRef.current;
      const oldest = first[first.length - 1];
      if (!prev || !oldest || prev.length <= first.length) {
        setEntries(first);
        setHasMore(r.data.has_more);
      } else {
        setEntries([...first, ...prev.filter((e) => e.id < oldest.id)]);
      }
    });
    commands.getDictionary().then(setDictionary);
    refreshStats();
  }, [refreshStats]);

  // Stable (state read through refs), so the scroll observer below is not
  // torn down and re-armed every time a request starts or ends.
  const loadMore = useCallback(async () => {
    const last = entriesRef.current?.[entriesRef.current.length - 1];
    if (!last || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const r = await commands
      .getHistoryEntries(last.id, PAGE)
      .catch(() => ({ status: "error" as const }));
    loadingMoreRef.current = false;
    setLoadingMore(false);
    if (r.status !== "ok") {
      setMoreFailed(true);
      return;
    }
    setMoreFailed(false);
    setEntries((prev) => {
      const have = new Set((prev ?? []).map((e) => e.id));
      return [
        ...(prev ?? []),
        ...r.data.entries.filter((e) => !have.has(e.id)),
      ];
    });
    setHasMore(r.data.has_more);
  }, []);

  useEffect(() => {
    refresh();
    const unHistory = events.historyUpdatePayload.listen(({ payload }) => {
      setFound((prev) => applyToFound(prev, payload));
      if (payload.action === "added")
        setEntries((prev) =>
          prev?.some((e) => e.id === payload.entry.id)
            ? prev
            : [payload.entry, ...(prev ?? [])],
        );
      else if (payload.action === "updated")
        setEntries((prev) =>
          (prev ?? []).map((e) =>
            e.id === payload.entry.id ? payload.entry : e,
          ),
        );
      else if (payload.action === "deleted")
        setEntries((prev) => (prev ?? []).filter((e) => e.id !== payload.id));
      else
        setEntries((prev) =>
          (prev ?? []).map((e) =>
            e.id === payload.id ? { ...e, saved: !e.saved } : e,
          ),
        );
      refreshStats();
    });
    const unDict = listen<DictionaryWord[]>("dictionary-changed", (e) =>
      setDictionary(e.payload),
    );
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      unHistory.then((f) => f());
      unDict.then((f) => f());
      clearInterval(tick);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, refreshStats]);

  // Older pages load when the end of the feed scrolls into view.
  useEffect(() => {
    if (!sentinel || !hasMore || moreFailed) return;
    const io = new IntersectionObserver((seen) => {
      if (seen[0]?.isIntersecting) loadMore();
    });
    io.observe(sentinel);
    return () => io.disconnect();
  }, [sentinel, hasMore, moreFailed, loadMore]);

  const terms = useMemo(() => searchTerms(query ?? ""), [query]);
  const termsKey = terms.join(" ");
  const searching = termsKey !== "";

  // The backend searches the whole history, a moment after typing stops.
  useEffect(() => {
    const seq = ++searchSeq.current;
    termsRef.current = termsKey;
    setFoundFailed(false);
    if (!termsKey) {
      setFound(null);
      return;
    }
    const timer = setTimeout(async () => {
      const r = await commands
        .searchHistoryEntries(termsKey, null, PAGE)
        .catch(() => ({ status: "error" as const }));
      if (seq !== searchSeq.current) return;
      if (r.status !== "ok") {
        toast.error(t("home.search.failed"));
        return;
      }
      setFound({
        q: termsKey,
        entries: r.data.entries,
        hasMore: r.data.has_more,
        total: r.data.total,
      });
    }, 150);
    return () => clearTimeout(timer);
  }, [termsKey, t]);

  const loadMoreFound = useCallback(async () => {
    const cur = foundRef.current;
    const last = cur?.entries[cur.entries.length - 1];
    // The results shown may still be for the previous query while the new
    // one loads; paging them would mix the two.
    if (!cur || !last || foundLoadingRef.current) return;
    if (cur.q !== termsRef.current) return;
    foundLoadingRef.current = true;
    setFoundLoading(true);
    const r = await commands
      .searchHistoryEntries(cur.q, last.id, PAGE)
      .catch(() => ({ status: "error" as const }));
    foundLoadingRef.current = false;
    setFoundLoading(false);
    if (cur.q !== termsRef.current) return;
    if (r.status !== "ok") {
      setFoundFailed(true);
      return;
    }
    setFoundFailed(false);
    setFound((prev) => appendFound(prev, cur.q, r.data));
  }, []);

  useEffect(() => {
    if (!foundSentinel || !found?.hasMore || foundFailed) return;
    const io = new IntersectionObserver((seen) => {
      if (seen[0]?.isIntersecting) loadMoreFound();
    });
    io.observe(foundSentinel);
    return () => io.disconnect();
  }, [foundSentinel, found?.hasMore, foundFailed, loadMoreFound]);

  const openSearch = useCallback(() => {
    setQuery((q) => {
      if (q === null) feedScroll.current = mainRef.current?.scrollTop ?? 0;
      return q ?? "";
    });
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  const closeSearch = useCallback(() => setQuery(null), []);

  // Opening scrolls the field into view; closing returns the feed to where it was.
  const open = query !== null;
  useLayoutEffect(() => {
    if (open) {
      searchRef.current?.scrollIntoView({ block: "nearest" });
    } else if (feedScroll.current !== null) {
      if (mainRef.current) mainRef.current.scrollTop = feedScroll.current;
      feedScroll.current = null;
    }
  }, [open]);

  // Cmd+F (Ctrl+F off macOS) opens the search, as in a browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = osType === "macos" ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [osType, openSearch]);

  // The apps' own icons (macOS), fetched once per app name.
  useEffect(() => {
    const names = [
      ...new Set(
        [...(entries ?? []), ...(found?.entries ?? [])]
          .map((e) => e.app_name)
          .filter((a): a is string => !!a),
      ),
    ].filter((a) => !(a in icons));
    if (!names.length) return;
    commands.getAppIcons(names).then((found) => {
      const urls: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(found)) {
        if (bytes)
          urls[name] = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: "image/png" }),
          );
      }
      // Remember the misses too, so they are not asked for again.
      setIcons((prev) => ({
        ...prev,
        ...Object.fromEntries(names.map((nm) => [nm, urls[nm] ?? ""])),
      }));
    });
  }, [entries, found, icons]);

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const r = await commands.getAudioFilePath(fileName);
        if (r.status !== "ok") return null;
        if (osType === "linux") {
          const data = await readFile(r.data);
          return URL.createObjectURL(new Blob([data], { type: "audio/wav" }));
        }
        return convertFileSrc(r.data, "asset");
      } catch {
        return null;
      }
    },
    [osType],
  );

  const toggleSaved = useCallback(async (id: number) => {
    // The list follows the backend's "toggled" event.
    const r = await commands.toggleHistoryEntrySaved(id);
    if (r.status === "error") toast.error(r.error);
  }, []);

  const deleteEntry = useCallback(
    async (id: number) => {
      setEntries((prev) => (prev ?? []).filter((e) => e.id !== id));
      setFound((prev) => applyToFound(prev, { action: "deleted", id }));
      const r = await commands.deleteHistoryEntry(id);
      if (r.status === "error") {
        toast.error(t("home.row.deleteFailed"));
        refresh();
      }
    },
    [refresh, t],
  );

  const onUpgrade = () =>
    upgrade().catch(() => toast.error(t("elchiPro.upgradeFailed")));

  const openFolder = async () => {
    const r = await commands.openRecordingsFolder();
    if (r.status === "error") toast.error(r.error);
  };

  const n = (v: number) => new Intl.NumberFormat(lang).format(v);
  const minutes = (m: number) => {
    const r = Math.max(m > 0 ? 1 : 0, Math.round(m));
    return r >= 60
      ? t("home.bar.hoursMinutes", { h: Math.floor(r / 60), m: r % 60 })
      : t("home.bar.minutes", { m: r });
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = (entries ?? []).map((e) => ({
      kind: "dictation",
      at: e.timestamp * 1000,
      entry: e,
    }));
    const oldest = out.length ? Math.min(...out.map((i) => i.at)) : now;
    for (const w of dictionary) {
      if (w.learned && (w.added_at ?? 0) * 1000 >= oldest)
        out.push({ kind: "learned", at: (w.added_at ?? 0) * 1000, word: w });
    }
    for (const m of stats?.milestones ?? []) {
      const at = Math.min(new Date(`${m.day}T23:59:00`).getTime(), now);
      if (at >= oldest) out.push({ kind: "milestone", at, words: m.words });
    }
    const today = out.filter(
      (i) =>
        i.kind === "dictation" &&
        dayKey(i.at) === dayKey(now) &&
        pastedText(i.entry).trim(),
    );
    if ((stats?.streak_days ?? 0) >= 3 && today.length) {
      // Right after the day's first dictation: that is when the streak grew.
      const first = Math.min(...today.map((i) => i.at));
      out.push({ kind: "streak", at: first + 1, days: stats!.streak_days });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [entries, dictionary, stats, now]);

  // The search's results, as dictation items: Elchi's posts stay out of them.
  const foundItems = useMemo<Item[]>(
    () =>
      (found?.entries ?? []).map((e) => ({
        kind: "dictation",
        at: e.timestamp * 1000,
        entry: e,
      })),
    [found],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of searching ? foundItems : items) {
      const k = dayKey(it.at);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    }
    return [...map.entries()];
  }, [items, foundItems, searching]);

  const rtf = useMemo(
    () =>
      new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "short" }),
    [lang],
  );
  // "4 dk. önce" -> "4 dk önce": the mono labels drop abbreviation dots.
  const when = (at: number) => {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (dayKey(at) !== dayKey(now))
      return new Date(at).toLocaleTimeString(lang, {
        hour: "2-digit",
        minute: "2-digit",
      });
    const rel =
      s < 60
        ? rtf.format(0, "second")
        : s < 3600
          ? rtf.format(-Math.floor(s / 60), "minute")
          : rtf.format(-Math.floor(s / 3600), "hour");
    return rel.replace(/\./g, "");
  };
  const dayLabel = (k: string) => {
    if (k === dayKey(now)) return t("home.today");
    if (k === dayKey(now - 86_400_000)) return t("home.yesterday");
    return new Date(`${k}T12:00:00`).toLocaleDateString(lang, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  };

  const binding = settings?.bindings?.transcribe?.current_binding ?? "";
  const keys = formatKeyCombination(binding, osType)
    .split(" + ")
    .filter(Boolean);
  const plan = status?.plan;
  const trialDays = daysLeft(status?.trial_ends_at);
  const empty = entries !== null && items.length === 0;
  const trialPost =
    !open &&
    plan === "trial" &&
    trialDays !== null &&
    trialDays <= 3 &&
    dismissedTrial !== status?.trial_ends_at;
  const showCard =
    !!status &&
    !open &&
    !trialPost &&
    (plan === "free" || (plan === "trial" && !empty));
  const noResults = searching && found?.q === termsKey && found.total === 0;
  const editingDay = groups.find(([, list]) =>
    list.some((i) => i.kind === "dictation" && i.entry.id === editingId),
  )?.[0];

  const dismissTrial = () => {
    const v = status?.trial_ends_at ?? "";
    setDismissedTrial(v);
    try {
      localStorage.setItem(TRIAL_POST_KEY, v);
    } catch {
      /* the post comes back next launch; nothing else to do */
    }
  };

  return (
    <div
      className={`h-screen flex flex-col bg-background select-none cursor-default ${dark ? "grain" : ""}`}
    >
      <TopBar
        status={status}
        onOpenSettings={onOpenSettings}
        onOpenMeetings={onOpenMeetings}
      />

      <main ref={mainRef} className="flex-1 overflow-y-auto">
        <div className="max-w-[1040px] mx-auto px-7 max-[720px]:px-5 pt-7 pb-7">
          {empty ? (
            <EmptyHero keys={keys} mac={osType === "macos"} dark={dark} />
          ) : (
            stats && entries !== null && <WeekHero stats={stats} dark={dark} />
          )}

          <div className="pt-2">
            {open && (
              <SearchField
                value={query}
                onChange={setQuery}
                onClose={closeSearch}
                count={searching && found?.total ? found.total : null}
                inputRef={searchRef}
              />
            )}

            {noResults && (
              <div className="flex flex-col items-center gap-2 py-14 text-center">
                <p className="label-mono">{t("home.search.empty")}</p>
                <p className="text-[15px] text-mid-gray break-words max-w-full">
                  {t("home.search.emptyBody", { query: query?.trim() })}
                </p>
              </div>
            )}

            {trialPost && (
              <section aria-label={t("home.fromElchi")}>
                <DayHeader aside={<SearchButton onClick={openSearch} />}>
                  {t("home.fromElchi")}
                </DayHeader>
                <ElchiPost
                  dark={dark}
                  when={t("home.today")}
                  title={t("home.trialTitle", { count: trialDays ?? 0 })}
                  body={
                    status && status.free_months > 0
                      ? t("home.trialBodyFree")
                      : t("home.trialBody")
                  }
                  actions={
                    <>
                      <ChipButton onClick={onUpgrade}>
                        {t("home.trialCta")}
                      </ChipButton>
                      <GhostButton onClick={dismissTrial}>
                        {t("home.dontShowAgain")}
                      </GhostButton>
                    </>
                  }
                />
              </section>
            )}

            {groups.map(([day, list], k) => (
              <section key={day} aria-label={dayLabel(day)}>
                <DayHeader
                  aside={
                    k === 0 &&
                    !open &&
                    !trialPost && <SearchButton onClick={openSearch} />
                  }
                >
                  {dayLabel(day)}
                  {day === editingDay && <> · {t("home.edit.editing")}</>}
                </DayHeader>
                {list.map((it) => {
                  const w = when(it.at);
                  switch (it.kind) {
                    case "dictation":
                      return (
                        <DictationRow
                          key={`d${it.entry.id}`}
                          entry={it.entry}
                          when={w}
                          dark={dark}
                          icon={
                            (it.entry.app_name && icons[it.entry.app_name]) ||
                            undefined
                          }
                          editing={editingId === it.entry.id}
                          onEdit={(on) => setEditingId(on ? it.entry.id : null)}
                          getAudioUrl={getAudioUrl}
                          onToggleSaved={toggleSaved}
                          onDelete={deleteEntry}
                          highlight={searching ? terms : undefined}
                        />
                      );
                    case "learned":
                      return (
                        <ElchiPost
                          key={`l${it.word.word}`}
                          dark={dark}
                          when={w}
                          title={
                            it.word.phrase && it.word.heard?.length
                              ? t("home.learnedPhraseTitle", {
                                  heard: it.word.heard[0],
                                  word: it.word.word,
                                })
                              : t("home.learnedTitle", { word: it.word.word })
                          }
                          body={
                            it.word.phrase
                              ? t("home.learnedPhraseBody")
                              : it.word.heard?.length
                                ? t("home.learnedHeard", {
                                    heard: it.word.heard[0],
                                  })
                                : t("home.learnedAdded")
                          }
                        />
                      );
                    case "streak":
                      return (
                        <ElchiPost
                          key="streak"
                          dark={dark}
                          when={w}
                          title={t("home.streakTitle", { count: it.days })}
                          body={t("home.streakBody", { count: it.days })}
                        />
                      );
                    case "milestone":
                      return (
                        <ElchiPost
                          key={`m${it.words}`}
                          dark={dark}
                          when={w}
                          title={t("home.milestoneTitle", { n: n(it.words) })}
                          body={t("home.milestoneBody", {
                            n: n(it.words),
                            time: minutes(it.words / (stats?.typing_wpm ?? 40)),
                          })}
                        />
                      );
                  }
                })}
              </section>
            ))}

            {searching && found?.q === termsKey && found.hasMore && (
              <div ref={setFoundSentinel} className="flex justify-center pt-5">
                <GhostButton onClick={loadMoreFound} disabled={foundLoading}>
                  {foundLoading
                    ? t("home.loading")
                    : foundFailed
                      ? t("home.moreFailed")
                      : t("home.more")}
                </GhostButton>
              </div>
            )}

            {!searching && hasMore && (
              <div ref={setSentinel} className="flex justify-center pt-5">
                <GhostButton onClick={loadMore} disabled={loadingMore}>
                  {loadingMore
                    ? t("home.loading")
                    : moreFailed
                      ? t("home.moreFailed")
                      : t("home.more")}
                </GhostButton>
              </div>
            )}

            {showCard && status && (
              <UpsellCard status={status} onUpgrade={onUpgrade} />
            )}

            {!searching &&
              entries !== null &&
              entries.length > 0 &&
              !hasMore && (
                <div className="flex justify-center pt-5">
                  <GhostButton onClick={openFolder}>
                    {t("home.openFolder")} ↗
                  </GhostButton>
                </div>
              )}
          </div>
        </div>
      </main>
    </div>
  );
};
