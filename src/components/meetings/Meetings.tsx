import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Mic, Volume2 } from "lucide-react";
import {
  commands,
  type ActiveMeeting,
  type Meeting,
  type MeetingDetail,
  type Segment,
} from "@/bindings";
import { useElchiPro } from "@/hooks/useElchiPro";
import { useSettings } from "@/hooks/useSettings";
import { ChipButton, GhostButton } from "../home/FeedRow";
import { MiniPlayer } from "../home/MiniPlayer";
import { useIsDark } from "../home/useIsDark";
import { dayKey } from "../home/text";
import { NotesHeader } from "./NotesHeader";
import { ShareDialog } from "./ShareDialog";
import {
  openTasks,
  parseNotes,
  summaryOf,
  toggleTask,
  type Section,
} from "./notesModel";
import {
  useActiveMeeting,
  useLiveMeeting,
  useMeetingList,
} from "./useMeetings";

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

const minutesOf = (m: Meeting) =>
  m.ended_at ? Math.max(1, Math.round((m.ended_at - m.started_at) / 60)) : null;

const mono =
  "font-mono text-[10.5px] tracking-[0.06em] uppercase text-[color:var(--text-faint)]";

const Label: React.FC<{ children: React.ReactNode; accent?: boolean }> = ({
  children,
  accent,
}) => (
  <h2
    className={`font-mono text-[10px] tracking-[0.12em] uppercase font-normal ${
      accent ? "text-logo-primary" : "text-text/40"
    }`}
  >
    {children}
  </h2>
);

/** The screen's steel bar: the way back, and what this view needs on the right. */
const Bar: React.FC<{
  back: string;
  onBack: () => void;
  center?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ back, onBack, center, children }) => (
  <header className="steel-bar relative z-10 flex-none h-14 px-6 max-[720px]:px-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
    <div>
      <GhostButton onClick={onBack} className="!px-1">
        <ArrowLeft className="inline w-3 h-3 me-1" aria-hidden="true" />
        {back}
      </GhostButton>
    </div>
    <div>{center}</div>
    <div className="flex items-center justify-end gap-2">{children}</div>
  </header>
);

/** A two-step destructive button: the first click asks, the second does it. */
const ConfirmButton: React.FC<{
  label: string;
  confirm: string;
  onConfirm: () => void;
}> = ({ label, confirm, onConfirm }) => {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 4000);
    return () => clearTimeout(timer);
  }, [asking]);
  return (
    <GhostButton
      onClick={() => (asking ? onConfirm() : setAsking(true))}
      className={asking ? "!text-red-500" : ""}
    >
      {asking ? confirm : label}
    </GhostButton>
  );
};

/** **bold** in the model's notes, nothing else. */
const Inline: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/(\*\*.+?\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i} className="font-medium">
          {part.slice(2, -2)}
        </strong>
      ) : (
        <React.Fragment key={i}>{part}</React.Fragment>
      ),
    )}
  </>
);

/** Before the first meeting: the people in it must be told it is recorded. */
const ConsentDialog: React.FC<{
  onAccept: () => void;
  onClose: () => void;
}> = ({ onAccept, onClose }) => {
  const { t } = useTranslation();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="meeting-consent-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-5"
      onKeyDown={(e) => e.key === "Escape" && onClose()}
    >
      <div className="steel-panel max-w-[460px] w-full p-6 flex flex-col gap-3">
        <h2 id="meeting-consent-title" className="text-[17px] font-medium">
          {t("meetings.consent.title")}
        </h2>
        <p className="text-[14px] leading-[1.55] text-mid-gray">
          {t("meetings.consent.body")}
        </p>
        <p className="text-[14px] leading-[1.55] text-mid-gray">
          {t("meetings.consent.privacy")}
        </p>
        <div className="flex justify-end gap-2 pt-2">
          <GhostButton onClick={onClose}>
            {t("meetings.consent.cancel")}
          </GhostButton>
          <ChipButton onClick={onAccept} autoFocus>
            {t("meetings.consent.accept")}
          </ChipButton>
        </div>
      </div>
    </div>
  );
};

/** Three bars that move with one side's level, for the live capsule. */
const Bars: React.FC<{ level: number; color: string; label: string }> = ({
  level,
  color,
  label,
}) => {
  const v = Math.min(1, Math.sqrt(level) * 2.6);
  return (
    <span
      role="img"
      aria-label={label}
      className="flex items-end gap-[2px] h-3.5"
    >
      {[0.55, 1, 0.75].map((k, i) => (
        <span
          key={i}
          className="w-[3px] rounded-sm transition-[height] duration-200"
          style={{ height: `${Math.max(3, v * k * 14)}px`, background: color }}
        />
      ))}
    </span>
  );
};

/** The meeting being recorded, as a notebook: the user writes; the transcript runs beside. */
const LiveMeeting: React.FC<{
  active: ActiveMeeting;
  onBack: () => void;
  onStopped: (id: number) => void;
}> = ({ active, onBack, onStopped }) => {
  const { t, i18n } = useTranslation();
  const { segments, partials, levels } = useLiveMeeting(active.id);
  const [now, setNow] = useState(Date.now());
  const [notes, setNotes] = useState("");
  const [title, setTitle] = useState("");
  const [stopping, setStopping] = useState(false);
  const saved = useRef({ notes: "", title: "" });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    commands.getMeeting(active.id).then((r) => {
      if (r.status !== "ok") return;
      setNotes(r.data.meeting.user_notes);
      setTitle(r.data.meeting.title);
      saved.current = {
        notes: r.data.meeting.user_notes,
        title: r.data.meeting.title,
      };
    });
  }, [active.id]);

  const save = useCallback(
    async (next: { notes: string; title: string }) => {
      if (next.notes !== saved.current.notes)
        await commands.setMeetingUserNotes(active.id, next.notes);
      if (next.title !== saved.current.title)
        await commands.setMeetingTitle(active.id, next.title);
      saved.current = next;
    },
    [active.id],
  );

  useEffect(() => {
    const timer = setTimeout(() => save({ notes, title }), 600);
    return () => clearTimeout(timer);
  }, [notes, title, save]);

  const stop = async () => {
    setStopping(true);
    await save({ notes, title });
    const r = await commands.stopMeeting();
    if (r.status === "error") {
      toast.error(r.error);
      setStopping(false);
      return;
    }
    onStopped(r.data);
  };

  const cancel = async () => {
    const r = await commands.cancelMeeting();
    if (r.status === "error") toast.error(r.error);
  };

  const recent = segments.slice(-8);
  const started = new Date(active.started_at * 1000);

  return (
    <>
      <Bar
        back={t("meetings.back")}
        onBack={onBack}
        center={
          <div
            role="group"
            aria-label={t("meetings.live.label")}
            className="flex items-center gap-3.5 ps-3.5 pe-1.5 py-1.5 rounded-full text-white shadow-[0_8px_20px_-10px_rgba(0,0,0,0.6)] bg-[linear-gradient(180deg,#23252e,#121318)]"
          >
            <span className="flex items-center gap-2 font-mono text-[12px] tabular-nums">
              <span
                aria-hidden="true"
                className="h-2 w-2 rounded-full bg-[#ff4646] animate-pulse"
              />
              {clock(now / 1000 - active.started_at)}
            </span>
            <Bars level={levels.me} color="#8ea0ff" label={t("meetings.me")} />
            {active.call_audio && (
              <Bars
                level={levels.them}
                color="rgba(255,255,255,0.75)"
                label={t("meetings.them")}
              />
            )}
            <button
              type="button"
              onClick={stop}
              disabled={stopping}
              className="inline-flex items-center gap-1.5 px-3.5 min-h-[30px] rounded-full bg-white text-[#141418] text-[13px] font-medium cursor-pointer disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              {stopping && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t("meetings.live.stop")}
            </button>
          </div>
        }
      >
        <ConfirmButton
          label={t("meetings.live.cancel")}
          confirm={t("meetings.live.cancelConfirm")}
          onConfirm={cancel}
        />
      </Bar>

      <div className="flex-1 min-h-0 flex flex-wrap overflow-y-auto">
        <main className="flex-[999_1_480px] min-w-0 px-14 max-[720px]:px-6 py-12 flex flex-col gap-3">
          <label className="flex flex-col">
            <span className="sr-only">{t("meetings.titleLabel")}</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("meetings.titlePlaceholder")}
              className="bg-transparent border-0 p-0 text-[32px] leading-tight font-medium tracking-[-0.02em] placeholder:text-text/30 focus:outline-none select-text"
            />
          </label>
          <p className={mono}>
            {started.toLocaleString(i18n.language, {
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          <label className="flex-1 flex flex-col pt-4">
            <span className="sr-only">{t("meetings.yourNotes")}</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => save({ notes, title })}
              placeholder={t("meetings.live.notesPlaceholder")}
              autoFocus
              className="flex-1 min-h-[320px] resize-none bg-transparent border-0 p-0 text-[17px] leading-[1.6] placeholder:text-text/30 focus:outline-none select-text"
            />
          </label>
        </main>

        <aside
          aria-label={t("meetings.live.rail")}
          className="flex-[1_1_240px] max-w-[300px] max-[720px]:max-w-none px-5 py-7 border-s border-mid-gray/15 flex flex-col gap-3.5"
        >
          <Label>{t("meetings.live.rail")}</Label>
          {!active.call_audio && (
            <p className="text-[12.5px] leading-[1.5] text-mid-gray">
              {t("meetings.live.micOnly")}
            </p>
          )}
          {recent.length === 0 && !partials.me && !partials.them ? (
            <p className="text-[13px] text-mid-gray">
              {t("meetings.live.waiting")}
            </p>
          ) : (
            recent.map((s, i) => (
              <p
                key={s.id}
                className="text-[13px] leading-[1.5] select-text"
                style={{ opacity: 0.35 + (0.65 * (i + 1)) / recent.length }}
              >
                <span
                  className={`block font-mono text-[9.5px] tracking-[0.06em] uppercase ${
                    s.speaker === "me" ? "text-logo-primary" : "text-text/60"
                  }`}
                >
                  {s.speaker === "me" ? t("meetings.me") : t("meetings.them")}
                </span>
                {s.text}
              </p>
            ))
          )}
          {(["them", "me"] as const).map(
            (speaker) =>
              partials[speaker] && (
                <p
                  key={speaker}
                  aria-live="polite"
                  className="text-[13px] leading-[1.5] italic text-text/55"
                >
                  <span
                    className={`block not-italic font-mono text-[9.5px] tracking-[0.06em] uppercase ${
                      speaker === "me" ? "text-logo-primary" : "text-text/60"
                    }`}
                  >
                    {speaker === "me" ? t("meetings.me") : t("meetings.them")}
                  </span>
                  {partials[speaker]}
                </p>
              ),
          )}
        </aside>
      </div>
    </>
  );
};

const TranscriptLines: React.FC<{ segments: Segment[] }> = ({ segments }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2.5 select-text cursor-text">
      {segments.map((s) => (
        <p key={s.id} className="text-[14.5px] leading-[1.5]">
          <span
            className={`me-2 font-mono text-[10px] tracking-[0.08em] uppercase ${
              s.speaker === "me"
                ? "text-logo-primary"
                : "text-[color:var(--text-faint)]"
            }`}
          >
            {s.speaker === "me" ? t("meetings.me") : t("meetings.them")}{" "}
            {clock(s.start_ms / 1000)}
          </span>
          {s.text}
        </p>
      ))}
    </div>
  );
};

/** The notes, the notebook way: the user's own lines as headings, Elchi's additions under
 *  them in its quieter ink, then the to-dos to tick. */
const Notes: React.FC<{
  sections: Section[];
  anyMine: boolean;
  onlyMine: boolean;
  onToggle: (at: number) => void;
}> = ({ sections, anyMine, onlyMine, onToggle }) => {
  const dark = useIsDark();
  const added = anyMine ? (dark ? "#9aa3e0" : "#555c8f") : undefined;
  const shown = onlyMine ? sections.filter((s) => s.mine) : sections;
  return (
    <article className="flex flex-col gap-6 select-text cursor-text">
      {shown.map((s, i) =>
        s.tasks ? (
          <section
            key={i}
            className="steel-panel px-5 py-4 flex flex-col gap-2.5 cursor-default"
          >
            <Label accent>{s.heading}</Label>
            {s.lines.map(
              (l) =>
                l.kind === "task" && (
                  <label
                    key={l.at}
                    className="flex gap-2.5 items-start text-[15px] leading-[1.45] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={l.done}
                      onChange={() => onToggle(l.at)}
                      className="mt-[3px] h-[17px] w-[17px] accent-[color:var(--color-accent)]"
                    />
                    <span
                      className={l.done ? "line-through text-mid-gray" : ""}
                    >
                      <Inline text={l.text} />
                    </span>
                  </label>
                ),
            )}
          </section>
        ) : (
          <section key={i} className="flex flex-col gap-1.5">
            {s.heading && (
              <h3
                className={`text-[18px] leading-snug ${
                  s.mine || !anyMine ? "font-medium" : "font-medium"
                }`}
                style={{ color: s.mine || !anyMine ? undefined : added }}
              >
                {s.heading}
              </h3>
            )}
            {!onlyMine && s.lines.length > 0 && (
              <ul
                className="flex flex-col gap-1 ps-5 list-disc text-[16px] leading-[1.55]"
                style={{ color: added }}
              >
                {s.lines.map((l) => (
                  <li
                    key={l.at}
                    className={l.kind === "text" ? "list-none -ms-5" : ""}
                  >
                    <Inline text={l.text} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ),
      )}
    </article>
  );
};

/** A finished meeting. */
const MeetingView: React.FC<{ id: number; onBack: () => void }> = ({
  id,
  onBack,
}) => {
  const { t, i18n } = useTranslation();
  const { status, upgrade } = useElchiPro();
  const dark = useIsDark();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [onlyMine, setOnlyMine] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [sharing, setSharing] = useState(false);
  // The header shows the title once the page's own title has scrolled out of view.
  const [titleShown, setTitleShown] = useState(false);
  const scroller = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [audio, setAudio] = useState<{
    me: string | null;
    them: string | null;
  }>({
    me: null,
    them: null,
  });

  const load = useCallback(async () => {
    const r = await commands.getMeeting(id);
    if (r.status === "ok") setDetail(r.data);
    else onBack();
  }, [id, onBack]);

  useEffect(() => {
    load();
    const un = listen("meetings-changed", load);
    return () => {
      un.then((f) => f());
    };
  }, [load]);

  useEffect(() => {
    if (!detail?.meeting.kept) return;
    Promise.all([
      commands.meetingAudioPath(id, "me"),
      commands.meetingAudioPath(id, "them"),
    ]).then(([me, them]) => setAudio({ me, them }));
  }, [id, detail?.meeting.kept]);

  const loaded = detail !== null;
  useEffect(() => {
    if (!loaded || !heading.current) return;
    const seen = new IntersectionObserver(
      ([entry]) => setTitleShown(!entry.isIntersecting),
      { root: scroller.current },
    );
    seen.observe(heading.current);
    return () => seen.disconnect();
  }, [loaded]);

  if (!detail) return null;
  const m = detail.meeting;
  const sections = m.notes ? parseNotes(m.notes, m.user_notes) : [];
  const anyMine = sections.some((s) => s.mine);
  const minutes = minutesOf(m);
  const pro = !!status?.cloud_active;

  const toggle = async (at: number) => {
    if (!m.notes) return;
    const notes = toggleTask(m.notes, at);
    setDetail({ ...detail, meeting: { ...m, notes } });
    await commands.setMeetingNotes(id, notes);
  };
  // The notes, or without them the transcript, one line per utterance.
  const copy = async () => {
    const body =
      m.notes ??
      detail.segments
        .map(
          (s) =>
            `${s.speaker === "me" ? t("meetings.me") : t("meetings.them")}: ${s.text}`,
        )
        .join("\n");
    await navigator.clipboard.writeText(
      [m.title && `# ${m.title}`, body].filter(Boolean).join("\n\n"),
    );
  };
  const retry = async () => {
    const r = await commands.retryMeetingNotes(id);
    if (r.status === "error") toast.error(r.error);
  };
  const remove = async () => {
    const r = await commands.deleteMeeting(id);
    if (r.status === "error")
      toast.error(
        r.error === "unshare_failed"
          ? t("meetings.share.errors.unshare_failed")
          : r.error,
      );
    else onBack();
  };
  const shareable =
    m.status !== "recording" &&
    m.status !== "processing" &&
    (!!m.notes || m.has_transcript || !!m.share_url);

  return (
    <>
      <NotesHeader
        back={t("meetings.title")}
        onBack={onBack}
        title={m.title.trim() || t("meetings.untitled")}
        meta={[
          new Date(m.started_at * 1000).toLocaleDateString(i18n.language, {
            day: "numeric",
            month: "long",
          }),
          minutes !== null && t("meetings.minutes", { count: minutes }),
        ]
          .filter(Boolean)
          .join(" · ")}
        titleShown={titleShown}
        filter={
          m.notes && anyMine ? { onlyMine, onChange: setOnlyMine } : undefined
        }
        onCopy={m.notes || detail.segments.length > 0 ? copy : undefined}
        share={
          shareable
            ? {
                shared: !!m.share_url,
                pro,
                onShare: () => setSharing(true),
              }
            : undefined
        }
        transcript={
          m.notes && detail.segments.length > 0
            ? {
                shown: showTranscript,
                count: detail.segments.length,
                onToggle: () => setShowTranscript((v) => !v),
              }
            : undefined
        }
        recordingPath={audio.me ?? audio.them}
        onDelete={remove}
      />
      {sharing && (
        <ShareDialog
          meeting={m}
          hasRecording={!!(audio.me || audio.them)}
          onClose={() => setSharing(false)}
        />
      )}

      <main ref={scroller} className="flex-1 overflow-y-auto">
        <div className="max-w-[700px] mx-auto px-7 max-[720px]:px-5 pt-12 pb-14 flex flex-col gap-4">
          <h1
            ref={heading}
            className="text-[32px] leading-tight tracking-[-0.02em] font-medium select-text"
          >
            {m.title.trim() || t("meetings.untitled")}
          </h1>
          <p className={mono}>
            {new Date(m.started_at * 1000).toLocaleString(i18n.language, {
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            })}
            {minutes !== null &&
              ` · ${t("meetings.minutes", { count: minutes })}`}
          </p>
          {anyMine && !onlyMine && (
            <p className="flex flex-wrap gap-4 text-[12.5px] text-mid-gray">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-[3px] bg-text"
                />
                {t("meetings.legend.mine")}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-[3px]"
                  style={{ background: dark ? "#9aa3e0" : "#8b93c9" }}
                />
                {t("meetings.legend.elchi")}
              </span>
            </p>
          )}

          <div className="pt-3 flex flex-col gap-6">
            {m.status === "processing" && (
              <p className="flex items-center gap-2 text-[14px] text-mid-gray">
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                {t("meetings.writing")}
              </p>
            )}
            {m.status === "empty" && (
              <p className="text-[14px] text-mid-gray">{t("meetings.empty")}</p>
            )}
            {(m.status === "no_notes" || m.status === "interrupted") && (
              <div className="steel-panel px-5 py-4 flex flex-wrap items-center gap-3">
                <p className="flex-1 min-w-[220px] text-[14px] leading-[1.5]">
                  {!pro
                    ? t("meetings.proOnly")
                    : m.status === "interrupted"
                      ? t("meetings.interrupted")
                      : t("meetings.failed")}
                </p>
                {!pro ? (
                  <ChipButton
                    onClick={() =>
                      upgrade().catch(() =>
                        toast.error(t("elchiPro.upgradeFailed")),
                      )
                    }
                  >
                    {t("meetings.upgrade")}
                  </ChipButton>
                ) : (
                  m.has_transcript && (
                    <ChipButton onClick={retry}>
                      {t("meetings.retry")}
                    </ChipButton>
                  )
                )}
              </div>
            )}

            {sections.length > 0 && (
              <Notes
                sections={sections}
                anyMine={anyMine}
                onlyMine={onlyMine}
                onToggle={toggle}
              />
            )}

            {!m.notes && m.user_notes.trim() && (
              <section className="flex flex-col gap-2">
                <Label>{t("meetings.yourNotes")}</Label>
                <p className="whitespace-pre-wrap text-[16px] leading-[1.55] select-text cursor-text">
                  {m.user_notes}
                </p>
              </section>
            )}

            {(audio.me || audio.them) && (
              <section className="flex flex-col gap-2">
                <Label>{t("meetings.recording")}</Label>
                {(["me", "them"] as const).map(
                  (side) =>
                    audio[side] && (
                      <div key={side} className="flex items-center gap-3">
                        <span className={`w-[90px] ${mono}`}>
                          {side === "me"
                            ? t("meetings.me")
                            : t("meetings.them")}
                        </span>
                        <MiniPlayer
                          load={async () =>
                            convertFileSrc(audio[side]!, "asset")
                          }
                          warm
                        />
                      </div>
                    ),
                )}
              </section>
            )}

            {detail.segments.length > 0 && (
              <section className="flex flex-col gap-3">
                <GhostButton
                  onClick={() => setShowTranscript((v) => !v)}
                  aria-expanded={showTranscript || !m.notes}
                  className="self-start !px-0"
                >
                  {showTranscript || !m.notes
                    ? t("meetings.hideTranscript")
                    : t("meetings.showTranscript", {
                        count: detail.segments.length,
                      })}
                </GhostButton>
                {(showTranscript || !m.notes) && (
                  <TranscriptLines segments={detail.segments} />
                )}
              </section>
            )}
          </div>
        </div>
      </main>
    </>
  );
};

/** The meetings list: start one, then every meeting by day with its first points. */
const MeetingList: React.FC<{
  meetings: Meeting[] | null;
  onBack: () => void;
  onOpen: (id: number) => void;
  onStart: () => void;
  starting: boolean;
}> = ({ meetings, onBack, onOpen, onStart, starting }) => {
  const { t, i18n } = useTranslation();
  const { getSetting } = useSettings();
  const { status } = useElchiPro();
  const keep = getSetting("meeting_keep_recording") ?? false;
  const mic = getSetting("selected_microphone") || t("meetings.defaultMic");
  const pro = !!status?.cloud_active;

  const now = Date.now();
  const dayLabel = (k: string) => {
    if (k === dayKey(now)) return t("home.today");
    if (k === dayKey(now - 86_400_000)) return t("home.yesterday");
    return new Date(`${k}T12:00:00`).toLocaleDateString(i18n.language, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  };
  const groups: [string, Meeting[]][] = [];
  for (const m of meetings ?? []) {
    const k = dayKey(m.started_at * 1000);
    const last = groups[groups.length - 1];
    if (last && last[0] === k) last[1].push(m);
    else groups.push([k, [m]]);
  }

  const retry = async (id: number) => {
    const r = await commands.retryMeetingNotes(id);
    if (r.status === "error") toast.error(r.error);
  };

  return (
    <>
      <Bar back={t("meetings.back")} onBack={onBack}>
        <span className={`${mono} max-[720px]:hidden`}>
          {keep ? t("meetings.privacy.kept") : t("meetings.privacy.notKept")}
        </span>
      </Bar>
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-[860px] mx-auto px-7 max-[720px]:px-5 pt-8 pb-12 flex flex-col gap-8">
          <section
            aria-label={t("meetings.new.title")}
            className="steel-panel px-7 py-6 flex flex-wrap items-center gap-6"
          >
            <div className="flex-[1_1_320px] flex flex-col gap-2">
              <h1 className="text-[24px] font-medium tracking-[-0.015em]">
                {t("meetings.new.title")}
              </h1>
              <p className="text-[14.5px] leading-[1.55] text-mid-gray">
                {pro ? t("meetings.new.body") : t("meetings.new.bodyFree")}
              </p>
              <div className="flex flex-wrap gap-2 pt-1.5">
                <span className="steel-chip !rounded-full inline-flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]">
                  <Mic
                    className="w-3.5 h-3.5 text-logo-primary"
                    aria-hidden="true"
                  />
                  {mic}
                </span>
                <span className="steel-chip !rounded-full inline-flex items-center gap-1.5 px-2.5 py-1 text-[12.5px]">
                  <Volume2
                    className="w-3.5 h-3.5 text-logo-primary"
                    aria-hidden="true"
                  />
                  {t("meetings.callAudio")}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onStart}
              disabled={starting}
              className="inline-flex items-center gap-2.5 px-5 min-h-[48px] rounded-full border border-[#1b2bd6] text-white text-[15px] font-medium bg-[linear-gradient(180deg,#3d57ff,#2140ff)] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_10px_22px_-10px_rgba(33,64,255,0.7)] cursor-pointer disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2"
            >
              {starting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full bg-white"
                />
              )}
              {t("meetings.new.start")}
            </button>
          </section>

          {groups.map(([day, list]) => (
            <section
              key={day}
              aria-label={dayLabel(day)}
              className="flex flex-col"
            >
              <Label>{dayLabel(day)}</Label>
              <ul className="pt-2">
                {list.map((m) => {
                  const minutes = minutesOf(m);
                  const todo = openTasks(m.notes);
                  const summary =
                    summaryOf(m.notes) ||
                    (m.status === "processing"
                      ? t("meetings.writing")
                      : m.status === "empty"
                        ? t("meetings.empty")
                        : m.status === "no_notes" || m.status === "interrupted"
                          ? t("meetings.status.noNotesLong")
                          : "");
                  const canRetry =
                    pro &&
                    m.has_transcript &&
                    (m.status === "no_notes" || m.status === "interrupted");
                  return (
                    <li
                      key={m.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1.5 py-[18px] px-1 hairline-t"
                    >
                      <button
                        type="button"
                        onClick={() => onOpen(m.id)}
                        className="text-start text-[17px] font-medium tracking-[-0.01em] truncate cursor-pointer hover:text-logo-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-sm"
                      >
                        {m.title.trim() || t("meetings.untitled")}
                      </button>
                      <span className={`${mono} self-center`}>
                        {new Date(m.started_at * 1000).toLocaleTimeString(
                          i18n.language,
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                        {minutes !== null &&
                          ` · ${t("meetings.minutes", { count: minutes })}`}
                      </span>
                      <p className="text-[14px] leading-[1.5] text-mid-gray line-clamp-2">
                        {summary}
                      </p>
                      <span className="self-start">
                        {canRetry ? (
                          <ChipButton onClick={() => retry(m.id)}>
                            {t("meetings.retry")}
                          </ChipButton>
                        ) : (
                          todo > 0 && (
                            <span className="inline-block px-2.5 py-1 rounded-full bg-accent/10 text-logo-primary font-mono text-[10px] tracking-[0.06em] uppercase whitespace-nowrap">
                              {t("meetings.todo", { count: todo })}
                            </span>
                          )
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </main>
    </>
  );
};

/**
 * Meetings: record a call (the user's microphone and the call's audio as two tracks,
 * nothing joins it), write in a notebook while the transcript runs beside it, and get
 * the notes written around those lines when it ends (Duyu Pro).
 */
export const Meetings: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { t } = useTranslation();
  const dark = useIsDark();
  const { getSetting, refreshSettings } = useSettings();
  const { active, refresh: refreshActive } = useActiveMeeting();
  const { meetings } = useMeetingList();
  const [selected, setSelected] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    const r = await commands.startMeeting();
    setStarting(false);
    if (r.status === "error")
      toast.error(t("meetings.startFailed", { error: r.error }));
    else {
      setSelected(null);
      refreshActive();
    }
  };

  const onStart = () => {
    if (getSetting("meeting_consent_ack")) start();
    else setAsking(true);
  };

  // "Take notes" in the call prompt, before the disclosure was read: it is read here
  // first. Asked as the page opens, and while it is open.
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;
  useEffect(() => {
    const take = () =>
      commands.takeMeetingStartRequest().then((r) => {
        if (r) onStartRef.current();
      });
    take();
    const un = listen("meeting-start-requested", take);
    return () => {
      un.then((f) => f());
    };
  }, []);

  const accept = async () => {
    setAsking(false);
    await commands.acknowledgeMeetingConsent();
    await refreshSettings();
    start();
  };

  const past = (meetings ?? []).filter((m) => m.id !== active?.id);

  return (
    <div
      className={`h-screen flex flex-col bg-background select-none cursor-default ${dark ? "grain" : ""}`}
    >
      {selected !== null ? (
        <MeetingView id={selected} onBack={() => setSelected(null)} />
      ) : active ? (
        <LiveMeeting active={active} onBack={onBack} onStopped={setSelected} />
      ) : (
        <MeetingList
          meetings={past}
          onBack={onBack}
          onOpen={setSelected}
          onStart={onStart}
          starting={starting}
        />
      )}
      {asking && (
        <ConsentDialog onAccept={accept} onClose={() => setAsking(false)} />
      )}
    </div>
  );
};
