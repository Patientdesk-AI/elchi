import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import type { AppSettings, DictionaryWord } from "@/bindings";
import { commands } from "@/bindings";
import { useSettings } from "../hooks/useSettings";
import { useElchiPro } from "../hooks/useElchiPro";
import { useModelStore } from "../stores/modelStore";
import { RailFooter } from "./footer";
import { useUpdater } from "./update-checker";
import { useChangedSettings } from "./settings/advanced/changedSettings";
import {
  GeneralSettings,
  AdvancedSettings,
  DebugSettings,
  AboutSettings,
  PostProcessingSettings,
  ModelsSettings,
  DictionarySettings,
} from "./settings";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

/**
 * Where a section lives: the four user tabs, the developer area (behind the
 * rail footer link), or nowhere in the rail (About opens from the version
 * line).
 */
type SectionPlace = "main" | "developer" | "hidden";

interface SectionConfig {
  labelKey: string;
  component: React.ComponentType;
  place: SectionPlace;
  /** Translation key of the single-letter keyboard hint (main tabs only). */
  hintKey?: string;
  enabled: (settings: AppSettings | null, developerOpen: boolean) => boolean;
}

export const SECTIONS_CONFIG = {
  general: {
    labelKey: "sidebar.general",
    component: GeneralSettings,
    place: "main",
    hintKey: "sidebar.hints.general",
    enabled: () => true,
  },
  models: {
    labelKey: "sidebar.models",
    component: ModelsSettings,
    place: "main",
    hintKey: "sidebar.hints.models",
    enabled: () => true,
  },
  dictionary: {
    labelKey: "sidebar.dictionary",
    component: DictionarySettings,
    place: "main",
    hintKey: "sidebar.hints.dictionary",
    enabled: () => true,
  },
  advanced: {
    labelKey: "sidebar.advanced",
    component: AdvancedSettings,
    place: "main",
    enabled: () => true,
  },
  debug: {
    labelKey: "sidebar.debug",
    component: DebugSettings,
    place: "developer",
    enabled: (_settings, developerOpen) => developerOpen,
  },
  postprocessing: {
    labelKey: "sidebar.postProcessing",
    component: PostProcessingSettings,
    place: "developer",
    // Listed once it is on, and always inside the open developer area so it
    // can be switched on there.
    enabled: (settings, developerOpen) =>
      developerOpen || (settings?.post_process_enabled ?? false),
  },
  about: {
    labelKey: "sidebar.about",
    component: AboutSettings,
    place: "hidden",
    enabled: () => true,
  },
} as const satisfies Record<string, SectionConfig>;

const SECTION_IDS = Object.keys(SECTIONS_CONFIG) as SidebarSection[];

/** The developer area is open while debug mode is on (Cmd/Ctrl+Shift+D). */
export const useDeveloperArea = () => {
  const { settings, updateSetting } = useSettings();
  const open = settings?.debug_mode ?? false;
  return {
    open,
    setOpen: (next: boolean) => updateSetting("debug_mode", next),
  };
};

const isTypingTarget = (target: EventTarget | null): boolean => {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  return (
    el.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
    el.closest("[role='dialog']") !== null
  );
};

interface SettingsRailProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
  /** Back to the home feed. */
  onHome: () => void;
}

/**
 * The settings left rail (design frames 1c / 3b / 3c): back to Eshlik, the four
 * user tabs with their letter shortcuts, the developer area once revealed, and
 * the footer with the engine and the version.
 */
export const SettingsRail: React.FC<SettingsRailProps> = ({
  activeSection,
  onSectionChange,
  onHome,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const developer = useDeveloperArea();

  const sections = SECTION_IDS.map((id) => ({
    id,
    ...(SECTIONS_CONFIG[id] as SectionConfig),
  })).filter((s) => s.enabled(settings, developer.open));
  const mainSections = sections.filter((s) => s.place === "main");
  const devSections = sections.filter((s) => s.place === "developer");

  // G / M / S (the hint letters) switch tabs while focus is not in a field
  // and no shortcut is being recorded.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector("[data-shortcut-recording]")) return;
      const key = e.key.toLocaleLowerCase();
      const match = mainSections.find(
        (s) => s.hintKey && t(s.hintKey).toLocaleLowerCase() === key,
      );
      if (match) {
        e.preventDefault();
        onSectionChange(match.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mainSections, onSectionChange, t]);

  const openDeveloper = async () => {
    await developer.setOpen(true);
    onSectionChange("debug");
  };

  const closeDeveloper = async () => {
    if (SECTIONS_CONFIG[activeSection].place === "developer") {
      onSectionChange("general");
    }
    await developer.setOpen(false);
  };

  return (
    <nav
      aria-label={t("sidebar.label")}
      className="rail h-full w-[200px] shrink-0 flex flex-col px-4 py-[22px] overflow-y-auto [scrollbar-width:none]"
    >
      <button
        type="button"
        onClick={onHome}
        className="self-start flex items-center gap-2 px-2.5 pb-[22px] font-mono text-[11px] tracking-[0.06em] text-text/50 hover:text-text cursor-pointer rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span aria-hidden="true" className="rtl:-scale-x-100">
          ←
        </span>
        <span>{t("sidebar.back")}</span>
      </button>

      <ul className="flex flex-col gap-0.5">
        {mainSections.map((section) => {
          const active = activeSection === section.id;
          return (
            <li key={section.id}>
              <button
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onSectionChange(section.id)}
                className={`w-full flex items-center justify-between px-2.5 py-[9px] rounded-[6px] text-[13px] text-start transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  active
                    ? "bg-text/[0.06] text-text"
                    : "text-text/70 hover:text-text hover:bg-text/[0.03]"
                }`}
              >
                <span className="truncate">{t(section.labelKey)}</span>
                {section.hintKey && (
                  <kbd
                    aria-hidden="true"
                    className="font-mono text-[10px] text-text/30"
                  >
                    {t(section.hintKey)}
                  </kbd>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {developer.open && (
        <div className="mt-3.5 pt-3.5 border-t border-[var(--hairline)] flex flex-col gap-0.5">
          <div className="flex items-baseline justify-between px-2.5 pt-1 pb-2">
            <span className="font-mono text-[10px] tracking-[0.12em] uppercase text-text/35">
              {t("sidebar.developer")}
            </span>
            <button
              type="button"
              onClick={closeDeveloper}
              className="font-mono text-[10px] tracking-[0.06em] uppercase text-text/35 hover:text-text cursor-pointer rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t("sidebar.developerHide")}
            </button>
          </div>
          {devSections.map((section) => {
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => onSectionChange(section.id)}
                className={`w-full flex items-center justify-between px-2.5 py-2 rounded-[6px] border text-[13px] text-start transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  active
                    ? "bg-accent/[0.14] border-accent/35 text-text"
                    : "border-transparent text-text/60 hover:text-text"
                }`}
              >
                <span className="truncate">{t(section.labelKey)}</span>
                {active && (
                  <span
                    aria-hidden="true"
                    className="w-1.5 h-1.5 rounded-full bg-logo-primary shadow-[0_0_8px_#2140ff]"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex-1 min-h-6" />
      <RailFooter
        showDeveloperLink={!developer.open}
        onOpenDeveloper={openDeveloper}
        onOpenAbout={() => onSectionChange("about")}
      />
    </nav>
  );
};

/** Word and phrase counts for the Sözlük header, kept current by events. */
const useDictionaryCounts = (active: boolean) => {
  const [words, setWords] = useState<DictionaryWord[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    commands
      .getDictionary()
      .then((w) => alive && setWords(w))
      .catch(() => undefined);
    const unlisten = listen<DictionaryWord[]>("dictionary-changed", (e) =>
      setWords(e.payload),
    );
    return () => {
      alive = false;
      unlisten.then((f) => f());
    };
  }, [active]);
  if (!words) return null;
  return {
    words: words.filter((w) => !w.phrase).length,
    phrases: words.filter((w) => w.phrase).length,
  };
};

const PageSummary: React.FC<{ section: SidebarSection }> = ({ section }) => {
  const { t } = useTranslation();
  const pro = useElchiPro().status;
  const { version } = useUpdater();
  const { changed, resettable, resetAll } = useChangedSettings();
  const dictionary = useDictionaryCounts(section === "dictionary");
  const localReady = useModelStore((s) =>
    s.models.some((m) => m.id === s.currentModel && m.is_downloaded),
  );

  switch (section) {
    case "general":
      return <>{t("sidebar.pageSummary.general")}</>;
    case "models":
      if (pro?.cloud_active) return <>{t("sidebar.pageSummary.modelsCloud")}</>;
      if (localReady) return <>{t("sidebar.pageSummary.modelsLocal")}</>;
      return <>{t("sidebar.pageSummary.modelsWhere")}</>;
    case "dictionary":
      if (!dictionary || dictionary.words + dictionary.phrases === 0)
        return null;
      return (
        <>
          {t("dictionary.count", { count: dictionary.words })}
          {dictionary.phrases > 0 &&
            ` · ${t("sidebar.pageSummary.phrases", { count: dictionary.phrases })}`}
        </>
      );
    case "advanced":
      if (changed.size === 0) return null;
      return (
        <>
          {t("sidebar.pageSummary.changed", { count: changed.size })}
          {resettable.size > 0 && " · "}
          {resettable.size > 0 && (
            <button
              type="button"
              onClick={() => void resetAll()}
              className="text-logo-primary uppercase tracking-[0.06em] hover:brightness-125 cursor-pointer rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t("sidebar.pageSummary.reset")}
            </button>
          )}
        </>
      );
    case "about":
      return version ? (
        <span className="normal-case">{`v${version}`}</span>
      ) : null;
    default:
      return null;
  }
};

/** Page title + the mono summary on the right ("KISAYOL · SES · ÇIKTI"). */
export const SettingsPageHeader: React.FC<{ section: SidebarSection }> = ({
  section,
}) => {
  const { t } = useTranslation();
  return (
    <header className="flex items-baseline justify-between gap-4">
      <h1 className="text-[20px] font-normal tracking-[-0.02em] text-text">
        {t(SECTIONS_CONFIG[section].labelKey)}
      </h1>
      <span className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-text/45 text-end">
        <PageSummary section={section} />
      </span>
    </header>
  );
};
