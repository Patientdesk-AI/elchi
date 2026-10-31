import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type KeyboardDiagnosticReport } from "@/bindings";
import { useOsType } from "../../../hooks/useOsType";

/**
 * Count-only keyboard capture test (macOS).
 *
 * Opens a short-lived listener and tallies how many key-down / key-up /
 * modifier / mouse events reach Eshlik — never *which* keys were pressed.
 * The signature of stuck Secure Input (issue #1578) is modifier events
 * flowing while key-down stays at zero.
 */
export const KeyboardDiagnostic: React.FC = () => {
  const { t } = useTranslation();
  const osType = useOsType();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<KeyboardDiagnosticReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (osType !== "macos") {
    return null;
  }

  const runDiagnostic = async () => {
    setRunning(true);
    setReport(null);
    setError(null);
    try {
      const result = await commands.runKeyboardDiagnostic(10);
      if (result.status === "ok") {
        setReport(result.data);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const verdict = (r: KeyboardDiagnosticReport): string => {
    if (r.secure_input_enabled && r.key_down === 0) {
      return t("settings.debug.keyboardDiagnostic.verdictBlocked");
    }
    if (!r.secure_input_enabled && r.key_down === 0 && r.flags_changed > 0) {
      return t("settings.debug.keyboardDiagnostic.verdictSuspicious");
    }
    if (r.key_down === 0 && r.flags_changed === 0 && r.mouse === 0) {
      return t("settings.debug.keyboardDiagnostic.verdictNoEvents");
    }
    return t("settings.debug.keyboardDiagnostic.verdictOk");
  };

  const secureInputLine = (r: KeyboardDiagnosticReport): string => {
    const state = r.secure_input_enabled
      ? t("settings.debug.keyboardDiagnostic.enabled")
      : t("settings.debug.keyboardDiagnostic.disabled");
    if (!r.secure_input_enabled) {
      return state;
    }
    const holder =
      r.culprit_name !== null
        ? t("settings.debug.keyboardDiagnostic.holder", {
            name: r.culprit_name,
            pid: r.culprit_pid,
          })
        : t("settings.debug.keyboardDiagnostic.holderUnknown");
    return `${state} — ${holder}`;
  };

  return (
    <div className="px-[18px] py-3.5 space-y-2">
      <div className="flex justify-between items-center gap-2">
        <div>
          <p className="text-[13.5px]">
            {t("settings.debug.keyboardDiagnostic.title")}
          </p>
          <p className="text-[11.5px] text-mid-gray">
            {t("settings.debug.keyboardDiagnostic.description")}
          </p>
        </div>
        <button
          type="button"
          onClick={runDiagnostic}
          disabled={running}
          className="steel-chip shrink-0 whitespace-nowrap px-2.5 py-1 font-mono text-[10.5px] tracking-[0.06em] uppercase cursor-pointer hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t("settings.debug.keyboardDiagnostic.run")}
        </button>
      </div>
      {running && (
        <p className="font-mono text-[10.5px] tracking-[0.06em] uppercase text-mid-gray animate-pulse">
          {t("settings.debug.keyboardDiagnostic.running")}
        </p>
      )}
      {error !== null && (
        <p className="text-[12px] text-error">
          {t("settings.debug.keyboardDiagnostic.failed", { error })}
        </p>
      )}
      {report !== null && (
        <div className="font-mono text-[11px] tracking-[0.02em] space-y-1 text-text/80">
          <p>
            {t("settings.debug.keyboardDiagnostic.secureInputLabel")}:{" "}
            {secureInputLine(report)}
          </p>
          <p>
            {t("settings.debug.keyboardDiagnostic.keyDown")}: {report.key_down}{" "}
            · {t("settings.debug.keyboardDiagnostic.keyUp")}: {report.key_up} ·{" "}
            {t("settings.debug.keyboardDiagnostic.flagsChanged")}:{" "}
            {report.flags_changed} ·{" "}
            {t("settings.debug.keyboardDiagnostic.mouse")}: {report.mouse}
          </p>
          <p className="font-sans font-medium">{verdict(report)}</p>
        </div>
      )}
    </div>
  );
};
