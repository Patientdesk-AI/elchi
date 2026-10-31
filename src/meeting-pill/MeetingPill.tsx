import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands, type Segment } from "@/bindings";
import ElchiMark from "@/components/icons/ElchiMark";
import {
  insertSegment,
  type PartialPayload,
  type Partials,
} from "@/components/meetings/liveTranscript";

/**
 * The meeting pill (src-tauri/src/meeting/pill.rs): Eshlik's mark and a level meter at the
 * screen's edge while a meeting is recorded. Hovering it (the backend watches the cursor
 * and sends `meeting-pill-open`) opens the live transcript beside it; clicking it opens the
 * meeting in Eshlik. Always dark, so it reads on any wallpaper or app.
 *
 * The same window asks when a call starts ("take notes?", without the pill) and when the
 * call app lets the microphone go mid-meeting ("stop the notes?", beside it): see
 * src-tauri/src/meeting/detect.rs.
 */

type Prompt = { kind: "start" | "stop"; app: string } | null;

const PromptCard: React.FC<{ prompt: NonNullable<Prompt> }> = ({ prompt }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const start = prompt.kind === "start";
  const accept = async () => {
    setBusy(true);
    if (start) await commands.meetingPromptStart();
    else {
      await commands.stopMeeting();
      await commands.openMeetingFromPill();
    }
    setBusy(false);
  };
  return (
    <section
      className="mp-ask"
      role="alertdialog"
      aria-labelledby="mp-ask-title"
    >
      <div className="mp-ask-head">
        {start && <ElchiMark size={18} color="#ffffff" />}
        <div>
          <h2 id="mp-ask-title">
            {t(start ? "meetings.pill.startTitle" : "meetings.pill.stopTitle")}
          </h2>
          <p>
            {t(start ? "meetings.pill.startBody" : "meetings.pill.stopBody", {
              app: prompt.app,
            })}
          </p>
        </div>
      </div>
      <div className="mp-ask-actions">
        <button
          type="button"
          className="mp-ask-later"
          onClick={() => commands.meetingPromptDismiss()}
        >
          {t(start ? "meetings.pill.notNow" : "meetings.pill.keep")}
        </button>
        <button
          type="button"
          className="mp-ask-go"
          disabled={busy}
          onClick={accept}
        >
          {t(start ? "meetings.pill.start" : "meetings.pill.stop")}
        </button>
      </div>
    </section>
  );
};

const MeetingPill: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [levels, setLevels] = useState({ me: 0, them: 0 });
  const [heard, setHeard] = useState(0);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [partials, setPartials] = useState<Partials>({ me: "", them: "" });
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let id: number | null = null;
    // The pill is reused from meeting to meeting: (re)load whichever one is on now.
    const load = async () => {
      const active = await commands.getActiveMeeting();
      if (!active || active.id === id) return;
      id = active.id;
      setSegments([]);
      setPartials({ me: "", them: "" });
      const r = await commands.getMeeting(active.id);
      if (r.status === "ok")
        setSegments((live) => r.data.segments.reduce(insertSegment, live));
    };
    load();
    const unChanged = listen("meetings-changed", load);
    const unOpen = listen<boolean>("meeting-pill-open", (e) =>
      setOpen(e.payload),
    );
    const unPrompt = listen<Prompt>("meeting-pill-prompt", (e) =>
      setPrompt(e.payload),
    );
    const unSegment = listen<{ meeting_id: number; segment: Segment }>(
      "meeting-segment",
      (e) => {
        if (id === null || e.payload.meeting_id === id)
          setSegments((s) => insertSegment(s, e.payload.segment));
      },
    );
    const unRemoved = listen<{ meeting_id: number; id: number }>(
      "meeting-segment-removed",
      (e) => {
        if (e.payload.meeting_id === id)
          setSegments((s) => s.filter((l) => l.id !== e.payload.id));
      },
    );
    const unPartial = listen<PartialPayload>("meeting-partial", (e) => {
      if (id === null || e.payload.meeting_id === id)
        setPartials((p) => ({ ...p, [e.payload.speaker]: e.payload.text }));
    });
    const unLevel = listen<{ me: number; them: number }>(
      "meeting-level",
      (e) => {
        setLevels(e.payload);
        if (Math.max(e.payload.me, e.payload.them) > 0.02) setHeard(Date.now());
      },
    );
    return () => {
      unChanged.then((f) => f());
      unOpen.then((f) => f());
      unPrompt.then((f) => f());
      unSegment.then((f) => f());
      unRemoved.then((f) => f());
      unPartial.then((f) => f());
      unLevel.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [open, segments.length, partials]);

  // Someone spoke in the last few seconds and their words are not in yet.
  const speaking = Boolean(partials.me || partials.them);
  const listening = !speaking && Date.now() - heard < 4000;
  const level = Math.min(1, Math.sqrt(Math.max(levels.me, levels.them)) * 2.6);
  const ink = levels.me >= levels.them ? "#8ea0ff" : "#ffffff";

  if (prompt?.kind === "start")
    return (
      <div className="mp-stage">
        <PromptCard prompt={prompt} />
      </div>
    );

  return (
    <div className="mp-stage">
      {prompt && <PromptCard prompt={prompt} />}
      {open && !prompt && (
        <section className="mp-panel" aria-label={t("meetings.live.rail")}>
          {segments.length === 0 && !listening && !speaking && (
            <p className="mp-empty">{t("meetings.live.waiting")}</p>
          )}
          {segments.map((s) => (
            <p
              key={s.id}
              className={`mp-bubble ${s.speaker === "me" ? "me" : "them"}`}
            >
              {s.text}
            </p>
          ))}
          {(["them", "me"] as const).map(
            (speaker) =>
              partials[speaker] && (
                <p
                  key={`partial-${speaker}`}
                  className={`mp-bubble ${speaker} mp-partial`}
                >
                  {partials[speaker]}
                </p>
              ),
          )}
          {listening && (
            <p
              className="mp-bubble them mp-listening"
              aria-label={t("meetings.pill.listening")}
            >
              <span />
              <span />
              <span />
            </p>
          )}
          <div ref={end} />
        </section>
      )}
      <button
        type="button"
        className="mp-pill"
        onClick={() => commands.openMeetingFromPill()}
        aria-label={t("meetings.pill.open")}
      >
        <ElchiMark size={20} color="#ffffff" />
        <span className="mp-bars" aria-hidden="true">
          {[0.55, 1, 0.7].map((k, i) => (
            <span
              key={i}
              style={{
                height: `${Math.max(4, level * k * 16)}px`,
                background: ink,
              }}
            />
          ))}
        </span>
      </button>
    </div>
  );
};

export default MeetingPill;
