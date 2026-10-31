import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { commands, type ElchiProStatus } from "@/bindings";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left until `iso` (at least 1 while it is still ahead). */
export const daysLeft = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / DAY_MS));
};

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

  const setUsePro = useCallback(async (enabled: boolean) => {
    setStatus(await commands.setElchiUsePro(enabled));
  }, []);

  const setFormat = useCallback(async (enabled: boolean) => {
    setStatus(await commands.setElchiFormat(enabled));
  }, []);

  return { status, upgrade, setUsePro, setFormat };
};
