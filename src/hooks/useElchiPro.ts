import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type ElchiProStatus } from "@/bindings";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long before `pro_until` Elchi asks for the paid subscription. */
const RENEW_WINDOW_DAYS = 5;
/** When the subscription reminder was last put off; it comes back a day later. */
const RENEW_SNOOZE_KEY = "elchi.pro.renewSnoozedAt";

const readSnoozedAt = (): number => {
  try {
    return Number(localStorage.getItem(RENEW_SNOOZE_KEY)) || 0;
  } catch {
    return 0;
  }
};

/** Whole days left until `iso` (at least 1 while it is still ahead). */
export const daysLeft = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / DAY_MS));
};

/** The monthly price as the plan cards show it: "₺200". */
export const formatTry = (amount: number, lang: string) =>
  new Intl.NumberFormat(lang, {
    style: "currency",
    currency: "TRY",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
  }).format(amount);

/**
 * The Duyu Pro plan (trial / Eshlik Pro / free), kept current from the
 * backend's `elchi-pro-changed` events and re-checked when the window gains
 * focus, so an upgrade made in the browser shows up as soon as the user comes
 * back.
 */
export const useElchiPro = () => {
  const [status, setStatus] = useState<ElchiProStatus | null>(null);

  useEffect(() => {
    let alive = true;
    commands
      .getElchiProStatus()
      .then((s) => alive && setStatus(s))
      .catch((e) => console.error("Failed to load Duyu Pro status:", e));
    const unlisten = listen<ElchiProStatus>("elchi-pro-changed", (e) =>
      setStatus(e.payload),
    );
    const onFocus = () => {
      commands.refreshElchiPro().then((r) => {
        if (alive && r.status === "ok") setStatus(r.data);
      });
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      unlisten.then((f) => f());
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const upgrade = useCallback(async () => {
    const r = await commands.openElchiUpgrade();
    if (r.status === "error") throw new Error(r.error);
  }, []);

  const subscribe = useCallback(async () => {
    const r = await commands.openElchiSubscribe();
    if (r.status === "error") throw new Error(r.error);
  }, []);

  const setUsePro = useCallback(async (enabled: boolean) => {
    setStatus(await commands.setElchiUsePro(enabled));
  }, []);

  const setFormat = useCallback(async (enabled: boolean) => {
    setStatus(await commands.setElchiFormat(enabled));
  }, []);

  return { status, upgrade, subscribe, setUsePro, setFormat };
};

/**
 * Elchi Pro runs out within a few days and nothing says a subscription pays
 * for it: the days left, and `snooze` to put the reminder off for a day. Null
 * otherwise. `subscribed` is null while the server does not say, so then the
 * reminder also shows to subscribers before each renewal and its copy says so.
 */
export const useRenewalReminder = (
  status: ElchiProStatus | null,
  { ignoreSnooze = false } = {},
) => {
  const [snoozedAt, setSnoozedAt] = useState(readSnoozedAt);

  const snooze = useCallback(() => {
    const now = Date.now();
    setSnoozedAt(now);
    try {
      localStorage.setItem(RENEW_SNOOZE_KEY, String(now));
    } catch {
      /* it comes back next launch; nothing else to do */
    }
  }, []);

  if (status?.plan !== "pro" || status.subscribed === true) return null;
  const days = daysLeft(status.pro_until);
  if (days === null || days === 0 || days > RENEW_WINDOW_DAYS) return null;
  if (!ignoreSnooze && Date.now() - snoozedAt < DAY_MS) return null;
  return { days, until: status.pro_until as string, snooze };
};
