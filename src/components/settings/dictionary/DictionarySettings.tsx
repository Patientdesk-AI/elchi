import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { type } from "@tauri-apps/plugin-os";
import { commands, type DictionaryWord } from "@/bindings";
import { useElchiPro } from "@/hooks/useElchiPro";
import { useSettings } from "@/hooks/useSettings";
import { ToggleSwitch } from "../../ui/ToggleSwitch";
import "./dictionary.css";

// The 18px conic-steel "×" on a chip or a ledger row.
const RemoveKnob: React.FC<{ label: string; onClick: () => void }> = ({
  label,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className="word-knob grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-[10px] leading-none text-text/70 hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 cursor-pointer"
  >
    <span aria-hidden="true">×</span>
  </button>
);

/**
 * The personal dictionary (src-tauri/src/dictionary), frame 2c: names, brands
 * and terms as steel chips with how Eshlik misheard them, the phrases it
 * misheard as a ledger, and whether corrections teach it. The page title and
 * counts come from the settings shell; this is the body.
 */
export const DictionarySettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { status } = useElchiPro();
  const { getSetting, refreshSettings } = useSettings();
  const [words, setWords] = useState<DictionaryWord[]>([]);
  const [draft, setDraft] = useState("");
  const learning = getSetting("elchi_dictionary_learn") ?? true;
  const isMac = type() === "macos";

  useEffect(() => {
    commands.getDictionary().then(setWords);
    const unlisten = listen<DictionaryWord[]>("dictionary-changed", (e) =>
      setWords(e.payload),
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const word = draft.trim();
    if (!word) return;
    setWords(await commands.addDictionaryWord(word));
    setDraft("");
  };

  const remove = async (word: string) =>
    setWords(await commands.removeDictionaryWord(word));

  const sorted = [...words]
    .filter((w) => !w.phrase)
    .sort((a, b) => a.word.localeCompare(b.word, i18n.language));
  const phrases = words
    .filter((w) => w.phrase)
    .sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0));
  const anyLearned = sorted.some((w) => w.learned);
  const isEmpty = sorted.length === 0 && phrases.length === 0;

  return (
    <div className="flex w-full flex-col gap-[22px]">
      {status && !status.format && (
        <p className="panel flex items-start gap-2.5 px-[18px] py-3 text-[12.5px] leading-normal">
          <span
            aria-hidden="true"
            className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
          />
          {t("dictionary.needsFormatting")}
        </p>
      )}

      <form onSubmit={add} className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={40}
          placeholder={t("dictionary.addPlaceholder")}
          aria-label={t("dictionary.addPlaceholder")}
          className="well h-10 min-w-0 flex-1 px-3.5 text-[13px] placeholder:text-text/40"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="steel-chip h-10 shrink-0 rounded-[8px] px-4 font-mono text-[11px] uppercase tracking-[0.06em] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {t("dictionary.add")}
        </button>
      </form>

      {isEmpty ? (
        <div className="panel flex flex-col gap-3 px-5 py-[18px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
            <span className="label-mono tracking-[0.12em]">
              {t("dictionary.emptyHint")}
            </span>
            <span className="flex items-baseline gap-2.5 text-[13px]">
              <span className="label-mono text-[10px]">
                {t("dictionary.example")}
              </span>
              <s className="text-text/45 decoration-text/30">
                {t("dictionary.exampleHeard")}
              </s>
              <span aria-hidden="true" className="text-logo-primary">
                →
              </span>
              <span>{t("dictionary.exampleWord")}</span>
            </span>
          </div>
          <p className="text-[13px] leading-normal">{t("dictionary.intro")}</p>
          <p className="text-[12px] leading-normal text-text/55 text-pretty">
            {isMac ? t("dictionary.howMac") : t("dictionary.howOther")}
          </p>
        </div>
      ) : (
        sorted.length > 0 && (
          <ul
            className="flex flex-wrap gap-2"
            aria-label={t("dictionary.title")}
          >
            {sorted.map((w) => {
              const heard = (w.heard ?? []).join(", ");
              return (
                <li
                  key={w.word}
                  className="steel-chip flex min-w-0 max-w-full items-center gap-2.5 rounded-full py-2 ps-3.5 pe-2.5"
                >
                  <span className="truncate text-[13px] font-medium leading-none">
                    {w.word}
                  </span>
                  {heard && (
                    <span className="min-w-0 truncate font-mono text-[10px] leading-none tracking-[0.04em] text-text/45">
                      <span className="uppercase">
                        {t("dictionary.heardLabel")}
                      </span>{" "}
                      <span className="text-text/75">{heard}</span>
                    </span>
                  )}
                  {w.learned && (
                    <span
                      className="dot-accent shrink-0"
                      title={t("dictionary.learned")}
                    >
                      <span className="sr-only">{t("dictionary.learned")}</span>
                    </span>
                  )}
                  <RemoveKnob
                    label={t("dictionary.remove", { word: w.word })}
                    onClick={() => remove(w.word)}
                  />
                </li>
              );
            })}
          </ul>
        )
      )}

      {phrases.length > 0 && (
        <section aria-labelledby="dictionary-phrases" className="space-y-2.5">
          <div className="flex items-baseline justify-between gap-4 px-0.5">
            <h2
              id="dictionary-phrases"
              className="label-mono tracking-[0.12em]"
              title={t("dictionary.phrasesHint")}
            >
              {t("dictionary.phrasesTitle")}
            </h2>
            {anyLearned && (
              <span className="label-mono flex items-center gap-1.5 tracking-[0.12em]">
                <span aria-hidden="true" className="dot-accent" />
                {t("dictionary.learned")}
              </span>
            )}
          </div>
          <ul
            className="panel divide-y divide-[var(--hairline)] overflow-hidden"
            aria-label={t("dictionary.phrasesTitle")}
          >
            {phrases.map((w) => {
              const heard = (w.heard ?? []).join(", ");
              return (
                <li
                  key={w.word}
                  className="grid grid-cols-[1fr_20px_1fr_auto] items-center gap-3.5 py-3.5 ps-[18px] pe-3.5 text-[13px]"
                >
                  {heard ? (
                    <s className="min-w-0 break-words text-text/45 decoration-text/30">
                      {heard}
                    </s>
                  ) : (
                    <span />
                  )}
                  <span
                    aria-hidden="true"
                    className="text-logo-primary rtl:-scale-x-100"
                  >
                    →
                  </span>
                  <span className="min-w-0 break-words">{w.word}</span>
                  <RemoveKnob
                    label={t("dictionary.remove", { word: w.word })}
                    onClick={() => remove(w.word)}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <ToggleSwitch
        checked={learning}
        onChange={async (enabled) => {
          await commands.setDictionaryLearning(enabled);
          await refreshSettings();
        }}
        label={t("dictionary.learnToggle")}
        description={t("dictionary.learnToggleDescription")}
        descriptionMode="inline"
      />
    </div>
  );
};
