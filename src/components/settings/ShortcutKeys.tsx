import React from "react";
import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";
import { Kbd } from "../ui/Kbd";
import { formatKeyCombination, type OSType } from "../../lib/utils/keyboard";

// macOS draws its modifiers as glyphs on the keycaps, as the design does.
const MAC_GLYPHS: Record<string, string> = {
  Option: "⌥",
  Alt: "⌥",
  Command: "⌘",
  Cmd: "⌘",
  Meta: "⌘",
  Shift: "⇧",
  Control: "⌃",
  Ctrl: "⌃",
};

const SHORT_NAMES: Record<string, string> = { Escape: "Esc" };

const capLabel = (part: string, osType: OSType): string => {
  const side = part.match(/^(Left|Right) (.+)$/);
  const name = side ? side[2] : part;
  const glyph = osType === "macos" ? MAC_GLYPHS[name] : undefined;
  const label = glyph ?? SHORT_NAMES[name] ?? name;
  // Keep the side ("L⌥") so side-specific bindings stay distinguishable.
  return side ? `${side[1][0]}${label}` : label;
};

/** A shortcut as steel keycaps: "option+space" → [⌥] [SPACE]. */
export const ShortcutKeys: React.FC<{
  binding: string;
  osType: OSType;
  className?: string;
}> = ({ binding, osType, className = "" }) => {
  const formatted = formatKeyCombination(binding, osType);
  const parts = formatted ? formatted.split(" + ") : [];
  return (
    <span
      className={`inline-flex items-center gap-1 ${className}`}
      aria-label={formatted}
    >
      {parts.map((part, i) => (
        <Kbd key={`${part}-${i}`} className="pointer-events-none">
          <span aria-hidden="true">{capLabel(part, osType)}</span>
        </Kbd>
      ))}
    </span>
  );
};

interface ShortcutButtonProps {
  binding: string;
  osType: OSType;
  /** Recording: show the keys pressed so far (or the prompt). */
  recording: boolean;
  recordingLabel: string;
  onStart: () => void;
  disabled?: boolean;
  label: string;
  recorderRef?: (el: HTMLButtonElement | null) => void;
}

/**
 * The clickable keycap group of a shortcut row: the keycaps and a blue pencil in one
 * steel chip, so it reads as something to change rather than a label. While recording
 * it becomes a blue-rimmed steel well that reads "Tuşlara basın…" / the live combination.
 */
export const ShortcutButton: React.FC<ShortcutButtonProps> = ({
  binding,
  osType,
  recording,
  recordingLabel,
  onStart,
  disabled = false,
  label,
  recorderRef,
}) => {
  const { t } = useTranslation();
  if (recording) {
    return (
      <button
        type="button"
        ref={recorderRef}
        data-shortcut-recording=""
        aria-live="polite"
        aria-label={label}
        className="well !border-accent/60 !shadow-[var(--well-shadow),0_0_0_3px_rgba(33,64,255,0.15)] inline-flex items-center gap-2 px-2.5 py-[5px] font-mono text-[10.5px] tracking-[0.06em] uppercase"
      >
        <span aria-hidden="true" className="dot-accent animate-pulse" />
        <span>{recordingLabel}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={disabled}
      aria-label={`${label}: ${t("settings.general.shortcut.change")}`}
      title={t("settings.general.shortcut.change")}
      className="group steel-chip !rounded-lg inline-flex items-center gap-2 ps-1.5 pe-1 py-1 cursor-pointer hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <ShortcutKeys binding={binding} osType={osType} />
      <span
        aria-hidden="true"
        className="grid place-items-center w-6 h-6 rounded-md bg-accent text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_8px_rgba(33,64,255,0.45)] group-hover:brightness-115"
      >
        <Pencil className="w-3.5 h-3.5" strokeWidth={2.25} />
      </span>
    </button>
  );
};
