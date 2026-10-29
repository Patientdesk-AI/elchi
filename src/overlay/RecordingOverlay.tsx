import { listen } from "@tauri-apps/api/event";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./RecordingOverlay.css";
import { commands, events } from "@/bindings";
import type {
  StreamPhase,
  StreamPhaseEvent,
  StreamTextEvent,
  StreamWorkKind,
} from "@/bindings";
import i18n, { syncLanguageFromSettings } from "@/i18n";
import type { ModelStateEvent } from "@/lib/types/events";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import { getLanguageDirection } from "@/lib/utils/rtl";

type OverlayState =
  | "idle"
  | "recording"
  | "streaming"
  | "transcribing"
  | "processing"
  | "nofield";

// Number of bar cells in the waveform (shared by every overlay form). Mic
// levels arrive as 16 FFT buckets, resampled across the bars.
const WAVE_BARS = 24;
const MIC_BUCKETS = 16;

// Cells in the model-loading meter; a highlight scans across them.
const LOAD_CELLS = 14;

// Resample the smoothed FFT buckets onto the bar count (linear interpolation),
// so every bar moves instead of neighbours repeating one bucket.
const resampleLevels = (buckets: number[]): number[] =>
  Array.from({ length: WAVE_BARS }, (_, i) => {
    const pos = (i / (WAVE_BARS - 1)) * (buckets.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(buckets.length - 1, lo + 1);
    const f = pos - lo;
    return (buckets[lo] ?? 0) * (1 - f) + (buckets[hi] ?? 0) * f;
  });

// Bars grow in whole 3px cells (2px lit + 1px gap), so the top cell is never cut.
const barHeight = (v: number): number => {
  const cells = Math.max(1, Math.min(6, 1 + Math.round(Math.pow(v, 0.7) * 5)));
  return cells * 3 - 1;
};

// The cancel shortcut as a keycap label ("escape" -> "Esc"; CSS uppercases it).
const cancelKeyLabel = (binding: string): string =>
  formatKeyCombination(binding, "unknown").replace(/\bEscape\b/, "Esc");

// Only call out a model load in the Live preview once it has run this long.
// Warm loads finish in well under this (~0.2s on Apple Silicon, ~1.5s on a
// Windows CPU backend), so the common case never flashes a loading notice while
// the user is speaking; cold loads can take 40s+.
const SLOW_MODEL_LOAD_MS = 2000;

// "Couldn't find where to type": how long the card stays up, and how long the
// "Copied" confirmation shows before it goes.
const NO_FIELD_MS = 6000;
const COPIED_MS = 1200;

const RecordingOverlay: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  // `Stream::play()` returning does not mean hardware callbacks are flowing.
  // Stay visually in an arming state until the backend processes the first
  // actual microphone sample chunk.
  const [captureReady, setCaptureReady] = useState(false);
  // Recording starts while the model loads in the background. Say so, otherwise
  // a cold start looks like an empty Live preview that ignores speech, then a
  // hung "Transcribing..." spinner. Once recording stops, any in-flight load is
  // the wait, so the working label reflects it immediately; the Live notice
  // waits for the load to be slow so fast loads don't flash it mid-speech.
  const [modelLoading, setModelLoading] = useState(false);
  const [modelLoadSlow, setModelLoadSlow] = useState(false);
  const modelLoadTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // Latched per Live session: once the loading notice has opened the panel, keep
  // it open after the load so it doesn't collapse and reopen when text arrives.
  const [loadNoticeShown, setLoadNoticeShown] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(WAVE_BARS).fill(0));
  const [streamText, setStreamText] = useState<StreamTextEvent>({
    committed: "",
    tentative: "",
  });
  const [phase, setPhase] = useState<StreamPhase>("listening");
  const [workKind, setWorkKind] = useState<StreamWorkKind>("transcribing");
  const [elapsed, setElapsed] = useState(0);
  // Bumped on each new streaming session so the Live card remounts fresh (replays
  // the pop-in, and never animates in from the previous panel's open size).
  const [session, setSession] = useState(0);
  // Overlay placement (top vs bottom of the screen). The Live panel grows downward
  // from a top overlay (oldest line under the pill) and upward from a bottom one.
  const [position, setPosition] = useState<"top" | "bottom">("bottom");
  // True once live text overflows the cap. A top overlay fades its top edge only
  // while overflowing, so the resting first line stays crisp flush under the pill.
  const [overflowing, setOverflowing] = useState(false);

  // The user's cancel shortcut, shown as the keycap on the Live panel.
  const [cancelKey, setCancelKey] = useState("escape");

  // A dictation that had no text field to go into: the pill shows its start and
  // the card above it offers to copy it.
  const [unplacedText, setUnplacedText] = useState("");
  const [copied, setCopied] = useState(false);

  const smoothedLevelsRef = useRef<number[]>(Array(MIC_BUCKETS).fill(0));
  // Live-text scroll-back: the text region "sticks" to the newest line while the
  // user is at the bottom; if they scroll up to read history, auto-follow pauses
  // until they scroll back down.
  const capRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const direction = getLanguageDirection(i18n.language);
  // Uppercase mono labels need the language on an ancestor so Turkish i maps
  // to İ; the document's own lang can still hold the pre-sync default.
  const lang = i18n.language;

  useEffect(() => {
    const setupEventListeners = async () => {
      const unlistenShow = await listen("show-overlay", async (event) => {
        const overlayState = event.payload as OverlayState;
        // Reset synchronously before settings I/O. A fast microphone can emit
        // recording-ready while the awaits below are in flight; resetting after
        // them would overwrite that event and leave the overlay stuck arming.
        if (overlayState === "recording" || overlayState === "streaming") {
          setCaptureReady(false);
          smoothedLevelsRef.current = Array(MIC_BUCKETS).fill(0);
          setLevels(Array(WAVE_BARS).fill(0));
          setStreamText({ committed: "", tentative: "" });
          setElapsed(0);
        }

        await syncLanguageFromSettings();
        // The Live panel flows downward from a top overlay and upward from a
        // bottom one; read the placement so the layout can flip to match.
        try {
          const settings = await commands.getAppSettings();
          if (settings.status === "ok") {
            setPosition(
              settings.data.overlay_position === "top" ? "top" : "bottom",
            );
            setCancelKey(
              settings.data.bindings?.cancel?.current_binding ?? "escape",
            );
          }
        } catch {
          // Keep the previous/default placement if settings can't be read.
        }
        setState(overlayState);
        setCopied(false);
        if (overlayState === "streaming") {
          setPhase("listening");
          setWorkKind("transcribing");
          setElapsed(0);
          setLoadNoticeShown(false);
          setSession((s) => s + 1); // remount the card fresh for this session
        }
        setIsVisible(true);
      });

      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
        setCaptureReady(false);
      });

      const unlistenNoField = await listen<string>("no-field-text", (event) => {
        setUnplacedText(event.payload);
      });

      const unlistenReady = await listen("recording-ready", () => {
        setElapsed(0);
        setCaptureReady(true);
      });

      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        const newLevels = event.payload as number[];
        // Exponential smoothing across the 16 buckets, then resample them onto
        // the waveform's bars.
        const smoothed = smoothedLevelsRef.current.map((prev, i) => {
          const target = newLevels[i] || 0;
          return prev * 0.7 + target * 0.3;
        });
        smoothedLevelsRef.current = smoothed;
        setLevels(resampleLevels(smoothed));
      });

      const unlistenStream = await events.streamTextEvent.listen((event) => {
        setStreamText(event.payload);
      });

      const unlistenPhase = await events.streamPhaseEvent.listen((event) => {
        const payload: StreamPhaseEvent = event.payload;
        setPhase(payload.phase);
        if (payload.kind) setWorkKind(payload.kind);
      });

      // The backend ends every `loading_started` with exactly one of completed
      // or failed, so only those end a load. Other events (e.g. `unloaded` from
      // the idle watcher) aren't ordered against an in-flight load and must not
      // clear it.
      const unlistenModel = await listen<ModelStateEvent>(
        "model-state-changed",
        (event) => {
          const type = event.payload.event_type;
          if (type === "loading_started") {
            clearTimeout(modelLoadTimerRef.current);
            setModelLoading(true);
            setModelLoadSlow(false);
            modelLoadTimerRef.current = setTimeout(
              () => setModelLoadSlow(true),
              SLOW_MODEL_LOAD_MS,
            );
          } else if (
            type === "loading_completed" ||
            type === "loading_failed"
          ) {
            clearTimeout(modelLoadTimerRef.current);
            setModelLoading(false);
            setModelLoadSlow(false);
          }
        },
      );

      return () => {
        unlistenShow();
        unlistenHide();
        unlistenNoField();
        unlistenReady();
        unlistenLevel();
        unlistenStream();
        unlistenPhase();
        unlistenModel();
        clearTimeout(modelLoadTimerRef.current);
      };
    };

    setupEventListeners();
  }, []);

  // Elapsed capture timer starts only once microphone samples are flowing.
  useEffect(() => {
    const capturing = state === "streaming" || state === "recording";
    if (!capturing || !isVisible || !captureReady) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [state, isVisible, captureReady]);

  // Stick to the bottom as text streams in — but only while pinned, so a user who
  // has scrolled up to read history isn't yanked back down by the next chunk.
  useLayoutEffect(() => {
    const el = capRef.current;
    if (!el) return;
    // Fade the top edge only once text actually overflows the cap.
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
    if (pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [streamText]);

  // `session` re-runs this when a new Live session starts mid-load (e.g. a
  // retry during a cold load), since the reset doesn't change the other deps.
  useEffect(() => {
    if (modelLoadSlow && state === "streaming") setLoadNoticeShown(true);
  }, [modelLoadSlow, state, session]);

  // The "Couldn't find where to type" card goes by itself: after a few seconds,
  // or shortly after Copy. The backend ignores this if anything else has been
  // shown since.
  useEffect(() => {
    if (state !== "nofield" || !isVisible) return;
    const id = setTimeout(
      () => commands.dismissNoFieldOverlay(),
      copied ? COPIED_MS : NO_FIELD_MS,
    );
    return () => clearTimeout(id);
  }, [state, isVisible, copied]);

  // Each fresh streaming session starts pinned to the bottom, fade cleared.
  useEffect(() => {
    pinnedRef.current = true;
    setOverflowing(false);
  }, [session]);

  if (!isVisible) return null;

  // Re-pin when the user is within ~a line of the bottom; unpin otherwise.
  const handleStreamScroll = () => {
    const el = capRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 16;
  };

  const fmtTime = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const transcribingLabel = modelLoading
    ? t("overlay.loadingModel")
    : t("overlay.transcribing");

  // ---- Shared building blocks (one visual language for every overlay form) ----
  // Blue while arming (shortcut seen, no samples yet), red once the mic is live.
  const dot = <span className={`sdot ${captureReady ? "live" : "arming"}`} />;

  // Bar cells driven by the mic levels. While arming they lie flat as a dashed
  // line, so nothing pretends audio is already arriving.
  const waveform = (
    <div
      className={`swave ${captureReady ? "ready" : "arming"}`}
      aria-hidden="true"
    >
      {levels.map((v, i) => (
        <i
          key={i}
          style={
            captureReady
              ? { height: `${barHeight(v)}px` }
              : ({ "--i": i } as React.CSSProperties)
          }
        />
      ))}
    </div>
  );

  const timer = (
    <span className={`stimer ${captureReady ? "" : "arming"}`}>
      {fmtTime(elapsed)}
    </span>
  );

  const xIcon = (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M5 5 L11 11 M11 5 L5 11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );

  const cancelBtn = (
    <button
      type="button"
      className="sx"
      aria-label={t("overlay.cancel")}
      onClick={() => commands.cancelOperation()}
    >
      {xIcon}
    </button>
  );

  // The Live panel names the cancel shortcut as a keycap instead of the round
  // ×; it stays clickable. Falls back to × if the shortcut is unbound.
  const keyLabel = cancelKeyLabel(cancelKey);
  const cancelKeycap = keyLabel ? (
    <button
      type="button"
      className="skey"
      aria-label={t("overlay.cancel")}
      title={t("overlay.cancel")}
      onClick={() => commands.cancelOperation()}
    >
      {keyLabel}
    </button>
  ) : (
    cancelBtn
  );

  // Indeterminate progress line: the backend reports no percentage, so a short
  // segment sweeps the track instead of faking a fill.
  const progress = (
    <span className="sprogress" aria-hidden="true">
      <i />
    </span>
  );

  // Model loading: a row of cells with a highlight scanning across them.
  const loadCells = (
    <span className="scells" aria-hidden="true">
      {Array.from({ length: LOAD_CELLS }, (_, i) => (
        <i key={i} style={{ "--i": i } as React.CSSProperties} />
      ))}
    </span>
  );

  // dot | waveform | timer + cancel — the same row in the pill and the panel.
  const listeningRow = (end: React.ReactNode) => (
    <div className="sbase">
      {dot}
      {waveform}
      <div className="sbase-r">
        {timer}
        {end}
      </div>
    </div>
  );

  // progress line (or loading cells) | mono label | cancel
  const workingRow = (
    label: string,
    loading: boolean,
    end: React.ReactNode,
  ) => (
    <div className="sbase working">
      {loading ? loadCells : progress}
      <span className="swork-label" aria-live="polite">
        {label}
      </span>
      {end}
    </div>
  );

  // ---- Live overlay: a pill that sculpts open into a panel ----
  if (state === "streaming") {
    const hasText =
      streamText.committed.length > 0 || streamText.tentative.length > 0;
    const working = phase === "working";
    // While listening, a slow model load opens the panel with a notice where the
    // text would be, so speech that isn't transcribing yet doesn't look ignored.
    const loadingNotice = modelLoadSlow && !working && !hasText;
    // Keep the panel open whenever there's text — even while finalizing — so the
    // transcript stays put under a working line instead of collapsing and
    // squishing the text mid-stream. Only fall back to the small working pill
    // when there was no text to preserve.
    const open = hasText || loadingNotice || (loadNoticeShown && !working);
    const collapsed = working && !hasText;
    const polishing = workKind === "polishing";
    const end = open ? cancelKeycap : cancelBtn;

    return (
      <div dir={direction} lang={lang} className={`ov-stage ${position}`}>
        <div
          key={session}
          className={`scard ${open ? "open" : ""} ${collapsed ? "working" : ""} ${
            isVisible ? "" : "leaving"
          }`}
        >
          <div className="stext">
            <div className="stext-clip">
              <div
                className={`stext-cap ${overflowing ? "overflowing" : ""}`}
                ref={capRef}
                onScroll={handleStreamScroll}
              >
                {loadingNotice ? (
                  <p className="sloading">
                    {loadCells}
                    <span className="swork-label">
                      {t("overlay.loadingModel")}
                    </span>
                  </p>
                ) : (
                  <p>
                    <span className="committed">
                      {streamText.committed ? streamText.committed + " " : ""}
                    </span>
                    <span className="tentative">{streamText.tentative}</span>
                    {/* Drop the blinking caret once finalizing — it's no
                        longer capturing, and the working line conveys it. */}
                    {!working && <span className="scaret" />}
                  </p>
                )}
              </div>
            </div>
          </div>
          {working
            ? workingRow(
                polishing ? t("overlay.processing") : transcribingLabel,
                modelLoading && !polishing,
                end,
              )
            : listeningRow(end)}
        </div>
      </div>
    );
  }

  // ---- Nowhere to type: the pill holds the dictation and a card pops out of
  // it, toward the screen's middle, offering to copy it. Never takes focus; the
  // card dismisses itself.
  if (state === "nofield") {
    const copy = async () => {
      const result = await commands.copyUnplacedDictation();
      if (result.status === "ok") setCopied(true);
    };
    return (
      <div
        dir={direction}
        lang={lang}
        className={`ov-stage ${position} ov-fade show`}
      >
        <div className="sheld">
          <section className="spop" role="alert">
            <p className="spop-msg">{t("overlay.noField.message")}</p>
            <button
              type="button"
              className={`scopy ${copied ? "done" : ""}`}
              onClick={copy}
              disabled={copied}
            >
              {/* Both labels share one grid cell, so the button is as wide as
                  the longer and the card doesn't jump when it says Copied. */}
              <span className={copied ? "off" : ""}>
                {t("overlay.noField.copy")}
              </span>
              <span className={copied ? "" : "off"} aria-live="polite">
                {t("overlay.noField.copied")}
              </span>
            </button>
          </section>
          <div className="scard compact">
            <div className="sbase">
              <span className="sdot held" />
              <span className="sheld-text">{unplacedText}</span>
              <button
                type="button"
                className="sx"
                aria-label={t("overlay.noField.dismiss")}
                onClick={() => commands.dismissNoFieldOverlay()}
              >
                {xIcon}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Minimal overlay: exactly one row at a time — waveform (recording), or a
  // progress line + label (transcribing / processing). Never both. The cancel
  // button is in both rows so it stays put.
  const working = state === "transcribing" || state === "processing";
  const workLabel =
    state === "processing" ? t("overlay.processing") : transcribingLabel;
  // "idle": the pill shrunk to a thin line between recordings
  // (overlay_idle_line); it keeps its place and grows back on the next session.
  const idle = state === "idle";

  return (
    <div
      dir={direction}
      lang={lang}
      className={`ov-stage ${position} ov-fade ${isVisible ? "show" : ""}`}
    >
      <div className={`scard compact ${idle ? "idle" : ""}`}>
        {idle
          ? null
          : working
            ? workingRow(
                workLabel,
                state === "transcribing" && modelLoading,
                cancelBtn,
              )
            : listeningRow(cancelBtn)}
      </div>
    </div>
  );
};

export default RecordingOverlay;
