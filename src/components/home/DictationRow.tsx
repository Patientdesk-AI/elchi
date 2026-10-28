import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands, type HistoryEntry } from "@/bindings";
import { AppTile } from "./AppTile";
import { ChipButton, GhostButton, RowHead } from "./FeedRow";
import { MiniPlayer } from "./MiniPlayer";
import {
  countWords,
  fold,
  matchRanges,
  pastedText,
  wordChanges,
  wordsOf,
} from "./text";

/** The "more" glyph; a symbol, not text to translate. */
const ELLIPSIS = "⋯";

/** The row's rarely used actions behind "⋯": keep, re-transcribe, delete. */
const MoreMenu: React.FC<{
  saved: boolean;
  onToggleSaved: () => void;
  onRetry: () => void;
  onDelete: () => void;
  onOpenChange: (open: boolean) => void;
}> = ({ saved, onToggleSaved, onRetry, onDelete, onOpenChange }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onOpenChange(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const item =
    "w-full text-start px-3 py-2 font-mono text-[10.5px] tracking-[0.06em] uppercase whitespace-nowrap hover:bg-text/[0.06] focus:outline-none focus-visible:bg-text/[0.08] cursor-pointer";

  return (
    <div ref={ref} className="relative">
      <ChipButton
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("home.row.more")}
        title={t("home.row.more")}
      >
        {ELLIPSIS}
      </ChipButton>
      {open && (
        <div
          role="menu"
          className="steel-panel !rounded-[8px] absolute end-0 top-[calc(100%+6px)] z-20 py-1 min-w-[180px] overflow-hidden"
        >
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={pick(onToggleSaved)}
          >
            {saved ? t("home.row.unkeep") : t("home.row.keep")}
          </button>
          <button
            role="menuitem"
            type="button"
            className={item}
            onClick={pick(onRetry)}
          >
            {t("home.row.retranscribe")}
          </button>
          <button
            role="menuitem"
            type="button"
            className={`${item} text-error`}
            onClick={pick(onDelete)}
          >
            {t("home.row.delete")}
          </button>
        </div>
      )}
    </div>
  );
};

/** Text with a search's matches marked. */
const Marked: React.FC<{ text: string; ranges: [number, number][] }> = ({
  text,
  ranges,
}) => {
  if (!ranges.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], k) => {
    if (start > at) out.push(text.slice(at, start));
    out.push(
      <mark
        key={k}
        className="rounded-[3px] bg-accent-soft/30 text-inherit [box-decoration-break:clone]"
      >
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  out.push(text.slice(at));
  return <>{out}</>;
};

/** A sunken text box that grows with its text. */
const GrowingText: React.FC<
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }
> = ({ value, className = "", ...props }) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      {...props}
      className={`block w-full resize-none bg-transparent caret-accent focus:outline-none ${className}`}
    />
  );
};

/**
 * One dictation in the feed, from the app it went into. Hovering (or
 * focusing) it shows its actions: copy, fix (the fix teaches the
 * dictionary), add a word to the dictionary, and the recording to play.
 */
export const DictationRow: React.FC<{
  entry: HistoryEntry;
  when: string;
  icon?: string;
  dark: boolean;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  onToggleSaved: (id: number) => void;
  onDelete: (id: number) => void;
  /** A search's folded words, to mark in the text. */
  highlight?: string[];
}> = ({
  entry,
  when,
  icon,
  dark,
  editing,
  onEdit,
  getAudioUrl,
  onToggleSaved,
  onDelete,
  highlight,
}) => {
  const { t, i18n } = useTranslation();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  // Unset until toggled.
  const [showHeard, setShowHeard] = useState<boolean | null>(null);
  const [word, setWord] = useState<string | null>(null);
  const [warm, setWarm] = useState(false);
  const [audible, setAudible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const selection = useRef("");

  const text = pastedText(entry);
  const hasText = text.trim().length > 0;
  const words = countWords(text);
  // What was pasted: before the user's correction, if they made one.
  const pasted = entry.edited_from ?? text;
  // "Formatted" only when the formatter changed the words (fillers dropped, a
  // correction resolved, a list made), not just capitals, punctuation or
  // spacing, which it touches in nearly every dictation.
  const formatted =
    hasText && wordsOf(pasted) !== wordsOf(entry.transcription_text);
  const changes = entry.edited_from ? wordChanges(entry.edited_from, text) : [];
  const marks = useMemo(
    () => (highlight?.length ? matchRanges(text, highlight) : []),
    [text, highlight],
  );
  const heardMarks = useMemo(
    () =>
      highlight?.length && formatted
        ? matchRanges(entry.transcription_text, highlight)
        : [],
    [entry.transcription_text, highlight, formatted],
  );
  // Shown on its own when a searched word is only in what was heard.
  const heardShown =
    showHeard ??
    (heardMarks.length > 0 &&
      !!highlight?.some((w) => !fold(text).includes(w)));
  // Re-transcribing rewrites the text when it lands, so no edit, word, second
  // retry or delete may start meanwhile: the actions hide until it is done.
  const busy = editing || word !== null || retrying;

  const startEdit = () => {
    setDraft(text);
    onEdit(true);
  };

  const save = async () => {
    setSaving(true);
    const r = await commands.editHistoryText(entry.id, draft);
    setSaving(false);
    if (r.status === "error") {
      toast.error(r.error);
      return;
    }
    onEdit(false);
    // What was learned is announced app-wide (the dictionary-learned event).
    if (r.data.length === 0) toast.success(t("home.edit.saved"));
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("home.row.copyFailed"));
    }
  };

  const addWord = async () => {
    const w = (word ?? "").trim();
    if (!w) return;
    try {
      await commands.addDictionaryWord(w);
      toast.success(t("home.dict.added", { word: w }));
      setWord(null);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    const r = await commands.retryHistoryEntryTranscription(entry.id);
    setRetrying(false);
    if (r.status === "error") toast.error(t("home.row.retranscribeFailed"));
  };

  const load = useCallback(
    () => getAudioUrl(entry.file_name),
    [getAudioUrl, entry.file_name],
  );

  const n = new Intl.NumberFormat(i18n.language).format(words);
  const reveal = busy
    ? "hidden"
    : audible || menuOpen
      ? "opacity-100"
      : "opacity-0 [.group:hover_&]:opacity-100 [.group:focus-within_&]:opacity-100 transition-opacity duration-150 motion-reduce:transition-none";

  return (
    <article
      className="group relative grid grid-cols-[36px_minmax(0,1fr)] gap-4 py-[18px] hairline-t"
      onMouseEnter={() => setWarm(true)}
      onFocus={() => setWarm(true)}
    >
      <AppTile app={entry.app_name} icon={icon} dark={dark} />
      <div className="flex flex-col gap-[7px] min-w-0">
        <RowHead name={entry.app_name ?? t("home.unknownApp")} when={when} />

        {editing ? (
          <div className="flex flex-col gap-2.5 mt-[3px]">
            <div className="well !rounded-[10px] px-3.5 py-3">
              <GrowingText
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") onEdit(false);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
                }}
                autoFocus
                aria-label={t("home.edit.label")}
                className="text-[15px] leading-[1.5]"
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="chrome-cta px-3 py-[7px] text-[12px] leading-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
              >
                {t("home.edit.save")}
              </button>
              <GhostButton onClick={() => onEdit(false)}>
                {t("home.edit.cancel")}
              </GhostButton>
              <span className="ms-auto font-mono text-[10px] tracking-[0.06em] uppercase text-text/35 text-end">
                {t("home.edit.hint")}
              </span>
            </div>
          </div>
        ) : retrying ? (
          <p className="text-[16px] leading-[1.45] text-mid-gray animate-pulse motion-reduce:animate-none">
            {t("home.row.transcribing")}
          </p>
        ) : hasText ? (
          <p className="text-[16px] leading-[1.45] tracking-[-0.005em] whitespace-pre-wrap break-words select-text cursor-text [text-wrap:pretty]">
            <Marked text={text} ranges={marks} />
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-[15px] text-mid-gray italic">
              {t("home.row.failed")}
            </p>
            <ChipButton onClick={retry}>{t("home.row.retry")}</ChipButton>
          </div>
        )}

        {word !== null && (
          <div className="flex flex-wrap items-center gap-2.5 mt-[2px]">
            <div className="well flex-1 min-w-[180px] px-3 py-[7px]">
              <input
                value={word}
                onChange={(e) => setWord(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addWord();
                  if (e.key === "Escape") setWord(null);
                }}
                autoFocus
                placeholder={t("home.dict.placeholder")}
                aria-label={t("home.dict.placeholder")}
                className="w-full bg-transparent text-[14px] caret-accent focus:outline-none placeholder:text-mid-gray"
              />
            </div>
            <button
              type="button"
              onClick={addWord}
              disabled={!word.trim()}
              className="chrome-cta px-3 py-[7px] text-[12px] leading-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
            >
              {t("home.dict.add")}
            </button>
            <GhostButton onClick={() => setWord(null)}>
              {t("home.edit.cancel")}
            </GhostButton>
          </div>
        )}

        {changes.length > 0 && !editing && (
          <p className="text-[12px] text-mid-gray">
            <span className="text-logo-primary">{t("home.corrected")}</span>
            {changes.map((c, k) => (
              <React.Fragment key={k}>
                {" · "}
                {c.from && <s className="decoration-text/30">{c.from}</s>}
                {c.from && c.to && " → "}
                {c.to && <span className="text-text">{c.to}</span>}
              </React.Fragment>
            ))}
          </p>
        )}

        {/* The recording plays even when transcription failed, so the user can
            hear whether it caught any speech before retrying. */}
        {!editing && (
          <div className="relative min-h-[14px] font-mono text-[10.5px] tracking-[0.04em] uppercase text-text/35">
            {hasText && (
              <span>
                {t("home.words", { count: words, n })}
                {formatted && <> · {t("home.formatted")}</>}
                {formatted && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => setShowHeard(!heardShown)}
                      aria-expanded={heardShown}
                      className="uppercase hover:text-logo-primary cursor-pointer focus:outline-none focus-visible:text-logo-primary focus-visible:underline"
                    >
                      {heardShown ? t("home.hideHeard") : t("home.showHeard")}
                    </button>
                  </>
                )}
                {entry.saved && <> · {t("home.row.kept")}</>}
              </span>
            )}
            <div
              className={`absolute end-0 top-1/2 -translate-y-1/2 normal-case ${reveal}`}
            >
              <MiniPlayer load={load} warm={warm} onActiveChange={setAudible} />
            </div>
          </div>
        )}

        {formatted && heardShown && !editing && (
          <div className="border-s-2 border-[color:var(--hairline-strong)] ps-3 flex flex-col gap-1">
            <span className="label-mono">{t("home.heard")}</span>
            <p className="text-[13.5px] leading-[1.45] text-mid-gray whitespace-pre-wrap break-words select-text cursor-text">
              <Marked text={entry.transcription_text} ranges={heardMarks} />
            </p>
          </div>
        )}
      </div>

      <div
        className={`absolute end-0 top-[13px] flex items-center gap-1.5 ${reveal}`}
      >
        {hasText && (
          <>
            <ChipButton onClick={copy}>
              {copied ? t("home.row.copied") : t("home.row.copy")}
            </ChipButton>
            <ChipButton onClick={startEdit}>{t("home.row.edit")}</ChipButton>
            <ChipButton
              onMouseDown={() => {
                selection.current = window.getSelection()?.toString() ?? "";
              }}
              onClick={() => setWord(selection.current.trim().slice(0, 80))}
              title={t("home.dict.hint")}
            >
              {t("home.row.toDictionary")}
            </ChipButton>
          </>
        )}
        <MoreMenu
          saved={entry.saved}
          onToggleSaved={() => onToggleSaved(entry.id)}
          onRetry={retry}
          onDelete={() => onDelete(entry.id)}
          onOpenChange={setMenuOpen}
        />
      </div>
    </article>
  );
};
