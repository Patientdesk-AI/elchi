import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Check } from "lucide-react";
import { GhostButton } from "../home/FeedRow";

/** The "more" glyph; a symbol, not text to translate. */
const ELLIPSIS = "⋯";

const square =
  "steel-chip !rounded-lg h-8 inline-flex items-center justify-center gap-1.5 text-[12.5px] font-medium whitespace-nowrap cursor-pointer hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

/** "Tümü / Benim yazdıklarım": every note, or only the lines the user wrote. The short
 *  label fits the default 760px window; wider windows spell it out. */
const Filter: React.FC<{
  onlyMine: boolean;
  onChange: (onlyMine: boolean) => void;
}> = ({ onlyMine, onChange }) => {
  const { t } = useTranslation();
  const segment = (active: boolean) =>
    `px-[10px] py-[5px] rounded-full font-mono text-[10px] leading-none tracking-[0.1em] uppercase whitespace-nowrap cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
      active
        ? "text-white bg-[linear-gradient(180deg,#4d68ff,#2140ff_55%,#1b2bd6)] shadow-[inset_0_1px_0_rgba(255,255,255,0.4)]"
        : "text-text/55 hover:text-text"
    }`;
  return (
    <div
      role="group"
      aria-label={t("meetings.filter.label")}
      className="steel-chip !rounded-full p-[3px] inline-flex"
    >
      <button
        type="button"
        aria-pressed={!onlyMine}
        className={segment(!onlyMine)}
        onClick={() => onChange(false)}
      >
        {t("meetings.filter.all")}
      </button>
      <button
        type="button"
        aria-pressed={onlyMine}
        className={segment(onlyMine)}
        onClick={() => onChange(true)}
      >
        <span className="min-[1000px]:hidden">
          {t("meetings.filter.mineShort")}
        </span>
        <span className="hidden min-[1000px]:inline">
          {t("meetings.filter.mine")}
        </span>
      </button>
    </div>
  );
};

/** Kopyala, which says "Kopyalandı ✓" for a moment instead of a toast. Fixed width, so
 *  the change never moves the header. */
const CopyButton: React.FC<{ onCopy: () => Promise<void> }> = ({ onCopy }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className={`${square} w-[100px]`}
      onClick={() => onCopy().then(() => setCopied(true))}
    >
      <span aria-live="polite">
        {copied ? t("meetings.copied") : t("meetings.copy")}
      </span>
      {copied && (
        <Check className="w-3.5 h-3.5 text-logo-primary" aria-hidden="true" />
      )}
    </button>
  );
};

/** The rarely used actions behind "⋯". Deleting asks once more inside the menu. */
const MoreMenu: React.FC<{
  transcript?: { shown: boolean; count: number; onToggle: () => void };
  recordingPath: string | null;
  shared: boolean;
  onDelete: () => void;
}> = ({ transcript, recordingPath, shared, onDelete }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setAsking(false);
      return;
    }
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
    "w-full flex items-center justify-between gap-3 text-start px-3.5 py-2 text-[13px] whitespace-nowrap hover:bg-text/[0.06] focus:outline-none focus-visible:bg-text/[0.08] cursor-pointer";

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`${square} w-8 text-text/70`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("meetings.more")}
        title={t("meetings.more")}
      >
        {ELLIPSIS}
      </button>
      {open && (
        <div
          role="menu"
          className="steel-panel !rounded-[10px] absolute end-0 top-[calc(100%+6px)] z-20 py-1.5 min-w-[210px] overflow-hidden"
        >
          {transcript && (
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={pick(transcript.onToggle)}
            >
              {transcript.shown
                ? t("meetings.hideTranscript")
                : t("meetings.showTranscript", { count: transcript.count })}
            </button>
          )}
          {recordingPath && (
            <button
              role="menuitem"
              type="button"
              className={item}
              onClick={pick(() => void revealItemInDir(recordingPath))}
            >
              {t("meetings.revealRecording")}
            </button>
          )}
          {(transcript || recordingPath) && (
            <div className="my-1.5 mx-3.5 hairline-t" aria-hidden="true" />
          )}
          {asking ? (
            <button
              role="menuitem"
              type="button"
              className={`${item} bg-error/10 hover:!bg-error/15 text-error`}
              onClick={pick(onDelete)}
            >
              {shared
                ? t("meetings.share.deleteConfirm")
                : t("meetings.deleteAsk")}
              <span className="rounded-md bg-error text-white px-2 py-[3px] text-[12px] font-medium">
                {t("meetings.delete")}
              </span>
            </button>
          ) : (
            <button
              role="menuitem"
              type="button"
              className={`${item} text-error`}
              onClick={() => setAsking(true)}
            >
              {t("meetings.delete")}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * A finished meeting's bar: back on the left, the title in the middle once the page's own
 * title has scrolled away (it truncates first), and the actions on the right: the notes
 * filter, Kopyala, Paylaş (the one primary action) and "⋯".
 */
export const NotesHeader: React.FC<{
  back: string;
  onBack: () => void;
  title: string;
  meta: string;
  titleShown: boolean;
  filter?: { onlyMine: boolean; onChange: (onlyMine: boolean) => void };
  onCopy?: () => Promise<void>;
  share?: { shared: boolean; pro: boolean; onShare: () => void };
  transcript?: { shown: boolean; count: number; onToggle: () => void };
  recordingPath: string | null;
  onDelete: () => void;
}> = ({
  back,
  onBack,
  title,
  meta,
  titleShown,
  filter,
  onCopy,
  share,
  transcript,
  recordingPath,
  onDelete,
}) => {
  const { t } = useTranslation();
  return (
    <header className="steel-bar relative z-10 flex-none h-14 px-6 max-[720px]:px-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
      <GhostButton onClick={onBack} className="!px-1">
        <ArrowLeft className="inline w-3 h-3 me-1" aria-hidden="true" />
        {back}
      </GhostButton>
      <div
        className={`flex items-center justify-center gap-2.5 min-w-0 transition-opacity duration-200 ${
          titleShown ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden={!titleShown}
      >
        <span className="text-[14px] font-medium truncate min-w-0">
          {title}
        </span>
        <span className="hidden min-[1000px]:inline font-mono text-[10px] tracking-[0.08em] uppercase whitespace-nowrap text-[color:var(--text-faint)]">
          {meta}
        </span>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {filter && (
          <>
            <Filter onlyMine={filter.onlyMine} onChange={filter.onChange} />
            <span
              className="w-px h-5 mx-1 bg-text/10 flex-none"
              aria-hidden="true"
            />
          </>
        )}
        {onCopy && <CopyButton onCopy={onCopy} />}
        {share && (
          <button
            type="button"
            className="chrome-cta !rounded-lg h-8 w-[108px] inline-flex items-center justify-center gap-1.5 text-[12.5px] whitespace-nowrap cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            onClick={share.onShare}
          >
            {share.shared ? (
              <>
                <span
                  className="h-1.5 w-1.5 rounded-full bg-accent"
                  aria-hidden="true"
                />
                {t("meetings.share.shared")}
              </>
            ) : (
              <>
                {t("meetings.share.button")}
                {!share.pro && (
                  <span className="blue-zone rounded-[4px] px-1 py-[2px] font-mono text-[8.5px] leading-none tracking-[0.08em]">
                    {t("meetings.proTag")}
                  </span>
                )}
              </>
            )}
          </button>
        )}
        <MoreMenu
          transcript={transcript}
          recordingPath={recordingPath}
          shared={share?.shared ?? false}
          onDelete={onDelete}
        />
      </div>
    </header>
  );
};
