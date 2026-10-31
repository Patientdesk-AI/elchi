import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Check } from "lucide-react";
import { events } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import { useOsType } from "@/hooks/useOsType";
import { daysLeft, useElchiPro } from "@/hooks/useElchiPro";
import { formatKeyCombination, type OSType } from "@/lib/utils/keyboard";
import {
  GhostButton,
  OnboardingShell,
  PrimaryButton,
  ProgressDashes,
  ShortcutKeys,
} from "./OnboardingShell";

interface WelcomeTourProps {
  onDone: () => void;
}

const STEPS = 3;
const SEEDS = [37, 41, 29];

const MAC_SYMBOLS: Record<string, string> = {
  Option: "⌥",
  Command: "⌘",
  Control: "⌃",
  Shift: "⇧",
};

/** The dictation shortcut as keycap labels, with the macOS modifier glyphs. */
const shortcutKeys = (binding: string, osType: OSType): string[] => {
  const label = formatKeyCombination(binding, osType);
  if (!label) return [];
  return label.split(" + ").map((k) => {
    if (osType !== "macos") return k;
    const base = k.replace(/^(Left|Right) /, "");
    return MAC_SYMBOLS[base] ? `${MAC_SYMBOLS[base]} ${k}` : k;
  });
};

const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Drives the "how to use it" demo: a beat on the click step, a beat on the
 * hold-and-speak step, then the text lands a few characters at a time.
 * Returns the characters shown and which of the three steps is active.
 */
const useDemoCycle = (text: string) => {
  const [tick, setTick] = useState(-1);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    setTick(0);
    const id = window.setInterval(() => setTick((n) => n + 1), 70);
    return () => window.clearInterval(id);
  }, [text]);

  const CLICK = 14;
  const SPEAK = 32;
  const typed = Math.ceil(text.length / 3);
  const cycle = SPEAK + typed + 30;
  if (tick < 0) return { shown: text.length, active: 2 };
  const t = tick % cycle;
  if (t < CLICK) return { shown: 0, active: 0 };
  if (t < SPEAK) return { shown: 0, active: 1 };
  return { shown: Math.min(text.length, (t - SPEAK + 1) * 3), active: 2 };
};

type PracticePhase = "idle" | "listening" | "working";

/** m:ss for the listening clock. */
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Bar-cell meter: still when idle, a gentle live motion while listening. */
const PracticeMeter: React.FC<{ live: boolean }> = ({ live }) => {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!live || prefersReducedMotion()) return;
    const id = window.setInterval(() => setT((n) => n + 1), 90);
    return () => window.clearInterval(id);
  }, [live]);
  return (
    <div aria-hidden="true" className="flex items-end gap-[3px] h-[18px]">
      {Array.from({ length: 24 }, (_, i) => {
        const h = live
          ? 3 +
            15 *
              Math.abs(
                Math.sin(t * 0.47 + i * 0.7) * Math.cos(t * 0.15 + i * 0.31),
              )
          : 3;
        return (
          <span
            key={i}
            className={`bar-cell transition-[height] duration-100 ${live ? "" : "opacity-40"}`}
            style={{ height: Math.round(h) }}
          />
        );
      })}
    </div>
  );
};

/**
 * First-run tour, after the permissions: what Eshlik does and why it is worth
 * it, how to dictate with the user's own shortcut, and a practice box to try
 * it once before using it anywhere.
 */
const WelcomeTour: React.FC<WelcomeTourProps> = ({ onDone }) => {
  const { t } = useTranslation();
  const osType = useOsType();
  const settings = useSettingsStore((s) => s.settings);
  const { status: pro } = useElchiPro();
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState("");
  const [phase, setPhase] = useState<PracticePhase>("idle");
  const phaseRef = useRef<PracticePhase>("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [live, setLive] = useState({ committed: "", tentative: "" });
  const practiceRef = useRef<HTMLTextAreaElement>(null);

  const keys = useMemo(
    () =>
      shortcutKeys(
        settings?.bindings?.transcribe?.current_binding ?? "",
        osType,
      ),
    [settings, osType],
  );
  const activation = settings?.shortcut_activation ?? "hold_or_toggle";

  // A dictation made during the practice step lands in the practice box (it
  // is focused, so Eshlik pastes into it); the history event is a fallback for
  // when pasting into our own window doesn't go through. The overlay's
  // show/hide events and the live stream text (broadcast to every window)
  // drive the panel's listening state while the user speaks.
  useEffect(() => {
    if (step !== 2) return;
    practiceRef.current?.focus();
    const unlistenHistory = events.historyUpdatePayload.listen((e) => {
      const p = e.payload;
      if (p.action !== "added") return;
      const text = (
        p.entry.post_processed_text ?? p.entry.transcription_text
      ).trim();
      if (text) {
        setTried((cur) => cur || text);
      }
    });
    const unlistenShow = listen<string>("show-overlay", (e) => {
      if (e.payload === "recording" || e.payload === "streaming") {
        if (phaseRef.current !== "listening") {
          setStartedAt(Date.now());
          setLive({ committed: "", tentative: "" });
        }
        phaseRef.current = "listening";
        setPhase("listening");
      } else {
        phaseRef.current = "working";
        setPhase("working");
      }
    });
    const unlistenHide = listen("hide-overlay", () => {
      phaseRef.current = "idle";
      setPhase("idle");
    });
    const unlistenStream = events.streamTextEvent.listen((e) =>
      setLive(e.payload),
    );
    const unlistenWorking = events.streamPhaseEvent.listen((e) => {
      if (e.payload.phase === "working") {
        phaseRef.current = "working";
        setPhase("working");
      }
    });
    return () => {
      for (const u of [
        unlistenHistory,
        unlistenShow,
        unlistenHide,
        unlistenStream,
        unlistenWorking,
      ]) {
        u.then((f) => f());
      }
    };
  }, [step]);

  // Tick the listening clock.
  useEffect(() => {
    if (phase !== "listening") return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [phase]);

  const success = tried.trim().length > 0;
  const next = () => (step < STEPS - 1 ? setStep(step + 1) : onDone());
  const demo = useDemoCycle(t("onboarding.tour.how.demo"));

  const panel = [
    {
      title: t("onboarding.tour.welcome.title"),
      body: t("onboarding.tour.welcome.lede"),
    },
    {
      title: t("onboarding.tour.how.title"),
      body: t("onboarding.tour.how.lede"),
    },
    success
      ? {
          title: t("onboarding.tour.try.successTitle"),
          body: t("onboarding.tour.try.successBody"),
        }
      : {
          title: t("onboarding.tour.try.title"),
          body:
            activation === "toggle"
              ? t("onboarding.tour.try.instructionToggle")
              : t("onboarding.tour.try.instructionHold"),
        },
  ][step];

  // The third point follows the real plan once it is known.
  const trialDays = pro?.plan === "trial" ? daysLeft(pro.trial_ends_at) : null;
  const planCard =
    pro?.plan === "pro"
      ? {
          title: t("onboarding.tour.welcome.proActive.title"),
          body: t("onboarding.tour.welcome.proActive.body"),
        }
      : pro?.plan === "free"
        ? {
            title: t("onboarding.tour.welcome.free.title"),
            body: t("onboarding.tour.welcome.free.body"),
          }
        : trialDays
          ? {
              title: t("onboarding.tour.welcome.trial.title", {
                count: trialDays,
              }),
              body: t("onboarding.tour.welcome.pro.body"),
            }
          : {
              title: t("onboarding.tour.welcome.pro.title"),
              body: t("onboarding.tour.welcome.pro.body"),
            };

  const features = [
    {
      title: t("onboarding.tour.welcome.anywhere.title"),
      body: t("onboarding.tour.welcome.anywhere.body"),
    },
    {
      title: t("onboarding.tour.welcome.languages.title"),
      body: t("onboarding.tour.welcome.languages.body"),
    },
    planCard,
  ];

  const howSteps = [
    t("onboarding.tour.how.step1"),
    activation === "toggle"
      ? t("onboarding.tour.how.step2Toggle")
      : t("onboarding.tour.how.step2Hold"),
    activation === "toggle"
      ? t("onboarding.tour.how.step3Toggle")
      : t("onboarding.tour.how.step3Hold"),
  ];

  const progressLabel = t("onboarding.tour.progress", {
    step: step + 1,
    total: STEPS,
  });

  return (
    <OnboardingShell
      seed={SEEDS[step]}
      centered={step < 2}
      titleKey={`t${step}${success}`}
      stepLabel={t("onboarding.layout.tourStep", {
        step: step + 1,
        total: STEPS,
      })}
      title={panel.title}
      body={panel.body}
      footer={
        <>
          <ProgressDashes
            on={Array.from({ length: STEPS }, (_, i) => i === step)}
            label={progressLabel}
            step={step + 1}
          />
          <div className="flex items-center gap-3">
            {/* The practice step offers "skip" instead of "back" (as in the
                design) until it succeeds; the row has no room for both. */}
            {step > 0 && !(step === 2 && !success) && (
              <GhostButton back onClick={() => setStep(step - 1)}>
                {t("onboarding.tour.back")}
              </GhostButton>
            )}
            {step === 2 && !success && (
              <GhostButton onClick={onDone}>
                {t("onboarding.tour.skip")}
              </GhostButton>
            )}
            <PrimaryButton onClick={next}>
              {step === 2
                ? t("onboarding.tour.start")
                : t("onboarding.tour.next")}
            </PrimaryButton>
          </div>
        </>
      }
    >
      <div
        key={step}
        className={`flex flex-col motion-safe:animate-[fadeIn_300ms_ease-out] ${
          step === 2 ? "flex-1 min-h-0 gap-[18px]" : "gap-[18px]"
        }`}
      >
        {step === 0 && (
          <ul className="flex flex-col gap-2.5">
            {features.map(({ title, body }, i) => (
              <li
                key={i}
                className="onb-card grid grid-cols-[auto_1fr] items-center gap-4 px-[18px] py-3.5"
              >
                <span className="min-w-7 font-mono text-[10px] tracking-[0.1em] text-accent-soft">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex flex-col gap-[3px]">
                  <span className="text-sm font-medium">{title}</span>
                  <span className="text-[12.5px] leading-normal text-mid-gray [text-wrap:pretty]">
                    {body}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}

        {step === 1 && (
          <>
            {keys.length > 0 && <ShortcutKeys keys={keys} size="lg" />}
            <ol className="flex flex-col gap-3">
              {howSteps.map((text, i) => {
                const active = i === demo.active;
                return (
                  <li
                    key={i}
                    className="grid grid-cols-[24px_1fr] items-baseline gap-3.5"
                  >
                    <span
                      className={`w-6 h-6 rounded-full grid place-items-center font-mono text-[10px] transition-colors duration-300 ${
                        active ? "gem" : "steel-chip !rounded-full"
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span
                      className={`text-sm leading-normal transition-colors duration-300 [text-wrap:pretty] ${
                        active ? "text-text" : "text-text/70"
                      }`}
                    >
                      {text}
                    </span>
                  </li>
                );
              })}
            </ol>
            <div
              aria-hidden="true"
              className="well rounded-xl px-4 py-3.5 min-h-[50px] text-[15px] leading-normal"
            >
              {t("onboarding.tour.how.demo").slice(0, demo.shown)}
              <span className="inline-block w-0.5 h-[15px] -mb-0.5 ml-0.5 bg-accent motion-safe:animate-pulse" />
            </div>
            {activation === "hold_or_toggle" && (
              <p className="text-[12.5px] leading-normal text-mid-gray">
                {t("onboarding.tour.how.longer")}
              </p>
            )}
          </>
        )}

        {step === 2 && (
          <>
            {keys.length > 0 && <ShortcutKeys keys={keys} />}
            <p className="text-[18px] font-light leading-[1.4] tracking-[-0.015em] text-text/85 [text-wrap:pretty]">
              “{t("onboarding.tour.try.phrase")}”
            </p>
            <label className="onb-glass flex-1 min-h-[150px] flex flex-col gap-3 px-5 pt-[18px] pb-4">
              <span className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)]">
                <span>{t("onboarding.tour.try.boxLabel")}</span>
                <span role="status" className="inline-flex items-center gap-2">
                  {success ? (
                    <>
                      <span className="gem w-[18px] h-[18px] grid place-items-center motion-safe:animate-[fadeIn_300ms_ease-out]">
                        <Check className="w-3 h-3" aria-hidden="true" />
                      </span>
                      <span className="text-accent-soft">
                        {t("onboarding.tour.try.done")}
                      </span>
                    </>
                  ) : phase === "listening" ? (
                    <span className="inline-flex items-center gap-2 text-accent-soft">
                      <span
                        aria-hidden="true"
                        className="w-1.5 h-1.5 rounded-full bg-current motion-safe:animate-pulse"
                      />
                      {t("onboarding.tour.try.listening", {
                        time: clock(now - (startedAt ?? now)),
                      })}
                    </span>
                  ) : phase === "working" ? (
                    <span className="text-accent-soft">
                      {t("onboarding.tour.try.working")}
                    </span>
                  ) : null}
                </span>
              </span>
              <span className="relative flex-1 flex flex-col min-h-0">
                <textarea
                  ref={practiceRef}
                  value={tried}
                  onChange={(e) => setTried(e.target.value)}
                  placeholder={
                    phase === "idle"
                      ? t("onboarding.tour.try.placeholder")
                      : undefined
                  }
                  className="flex-1 w-full min-h-[52px] bg-transparent p-0 text-[17px] leading-[1.45] tracking-[-0.01em] resize-none border-0 focus:outline-none placeholder:text-mid-gray/70 caret-accent"
                />
                {/* Live text while speaking, until the paste lands. */}
                {!success && phase !== "idle" && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 text-[17px] leading-[1.45] tracking-[-0.01em]"
                  >
                    {live.committed}
                    <span className="text-text/40">{live.tentative}</span>
                    <span className="inline-block w-0.5 h-4 -mb-0.5 ml-0.5 bg-accent motion-safe:animate-pulse" />
                  </span>
                )}
              </span>
              <PracticeMeter live={!success && phase === "listening"} />
            </label>
            {success && (
              <p className="text-[12.5px] leading-normal text-mid-gray">
                {t("onboarding.tour.try.anywhere")}
              </p>
            )}
          </>
        )}
      </div>
    </OnboardingShell>
  );
};

export default WelcomeTour;
