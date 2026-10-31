import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, X } from "lucide-react";
import { commands, type SecureInputStatus } from "@/bindings";

// Detailed remediation steps live in the docs rather than in the banner.
// TODO(elchi): set to Eshlik's own troubleshooting page once it is published;
// while empty, the "learn more" link is hidden.
export const SECURE_INPUT_HELP_URL: string = "";

/**
 * Compact warning banner shown while macOS Secure Input is stuck on.
 *
 * Secure Input (password fields, Terminal's "Secure Keyboard Entry", a stuck
 * loginwindow) blocks key events from reaching Eshlik's keyboard listener, so
 * keyed shortcuts silently stop firing (issue #1578). The backend monitor
 * emits `secure-input-changed` on state transitions; `sustained` filters out
 * the normal momentary activation from focusing a password field.
 */
const SecureInputWarning: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SecureInputStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await commands.getSecureInputStatus());
    } catch (e) {
      console.warn("Failed to fetch secure input status:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const unlisten = listen<SecureInputStatus>(
      "secure-input-changed",
      (event) => setStatus(event.payload),
    );
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // Only warn when the user is actually impacted: a binding is degraded
  // (side-specific matching widened) or dead (e.g. fn+key), or they ran into
  // the blocked shortcut recorder. When the fallback covers everything
  // transparently — and nothing else surfaced — stay silent; the backend
  // still logs.
  const impacted =
    status !== null &&
    ((status.sustained &&
      (status.degraded_bindings.length > 0 ||
        status.uncovered_bindings.length > 0)) ||
      status.recorder_blocked);

  // A dismissal lasts for the current episode only: once the condition
  // clears, the next occurrence warns again. The tray badge is the
  // persistent indicator and is not dismissible.
  useEffect(() => {
    if (!impacted) {
      setDismissed(false);
    }
  }, [impacted]);

  if (!impacted || dismissed) {
    return null;
  }

  const affectedCount = new Set([
    ...status.uncovered_bindings,
    ...status.degraded_bindings,
  ]).size;
  const countSuffix = affectedCount === 1 ? "one" : "other";
  const message =
    affectedCount > 0
      ? status.culprit_name !== null
        ? t(`secureInput.blockedWithCulprit_${countSuffix}`, {
            name: status.culprit_name,
            count: affectedCount,
          })
        : t(`secureInput.blockedNoCulprit_${countSuffix}`, {
            count: affectedCount,
          })
      : status.culprit_name !== null
        ? t("secureInput.recorderBlockedWithCulprit", {
            name: status.culprit_name,
          })
        : t("secureInput.recorderBlockedNoCulprit");

  return (
    <div
      role="status"
      className="steel-panel !rounded-[10px] !shadow-[var(--steel-chip-shadow)] grid grid-cols-[22px_1fr_auto] items-center gap-3 px-3.5 py-3"
    >
      <span
        aria-hidden="true"
        className="w-[22px] h-[22px] rounded-full grid place-items-center bg-[linear-gradient(180deg,#ffd27a,#b7791f)] shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] text-[#2b1a00] font-mono text-[11px] font-medium"
      >
        !
      </span>
      <div className="flex flex-col gap-0.5 min-w-0">
        <p className="text-[13px] leading-snug">{message}</p>
        <p className="font-mono text-[10px] tracking-[0.06em] uppercase text-mid-gray">
          {t("secureInput.label")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {SECURE_INPUT_HELP_URL && (
          <button
            type="button"
            onClick={() => openUrl(SECURE_INPUT_HELP_URL)}
            className="steel-chip inline-flex items-center gap-1 px-2.5 py-[5px] font-mono text-[10px] tracking-[0.06em] uppercase whitespace-nowrap cursor-pointer hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t("secureInput.learnMore")}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label={t("secureInput.dismiss")}
          className="cursor-pointer rounded-md p-1.5 text-mid-gray hover:bg-text/[0.06] hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

export default SecureInputWarning;
