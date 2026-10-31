import React, { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { SpectralCanvas } from "../../ui/SpectralCanvas";
import { Switch } from "../../ui/Switch";
import { daysLeft, useElchiPro } from "@/hooks/useElchiPro";
import "./models.css";

/**
 * Duyu Pro, the cloud model, as the page's one total-blue zone: the pixel
 * field on the right fading into flat blue under the text. During the trial
 * and on the free plan it carries the upgrade; with Eshlik Pro it shows the
 * subscription instead. The "use Duyu Pro" switch sits in a frosted tile at
 * the bottom of the zone whenever the plan includes the cloud.
 */
export const ElchiProCard: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { status, upgrade, setUsePro } = useElchiPro();
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const tileDescId = useId();

  if (!status) return null;

  const plan = status.plan;
  const price = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "TRY",
    currencyDisplay: "narrowSymbol",
    maximumFractionDigits: 0,
  }).format(status.price_try_monthly);
  const proUntil = status.pro_until
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "long" }).format(
        new Date(status.pro_until),
      )
    : null;

  const onUpgrade = async () => {
    setError(null);
    try {
      await upgrade();
    } catch {
      setError(t("elchiPro.upgradeFailed"));
    }
  };

  // "DUYU PRO · BULUT · DENEME 6 GÜN" — the plan's state, from the server.
  const planLabel =
    plan === "trial"
      ? t("settings.models.pro.trialDays", {
          count: daysLeft(status.trial_ends_at) ?? 0,
        })
      : plan === "pro"
        ? t("settings.models.pro.proPlan")
        : plan === "free"
          ? t("settings.models.pro.trialEnded")
          : null;

  const offer = [
    t("settings.models.pro.price", { price }),
    ...(status.free_months > 0
      ? [t("settings.models.pro.freeMonths", { count: status.free_months })]
      : []),
  ].join(" · ");

  const includesCloud = plan === "trial" || plan === "pro";

  return (
    <section
      aria-labelledby={titleId}
      className="pro-zone blue-zone relative overflow-hidden rounded-[12px] px-6 py-[22px]"
    >
      <SpectralCanvas
        mode="pro"
        seed={7}
        className="absolute inset-y-0 end-0 h-full w-[55%]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 rtl:-scale-x-100"
        style={{
          background:
            "linear-gradient(90deg, #2140FF 50%, rgba(33,64,255,0) 88%)",
        }}
      />

      <div className="relative flex flex-col gap-3.5">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-white/85">
          {t("settings.models.pro.eyebrow")}
          {planLabel && ` · ${planLabel}`}
        </p>
        <h2
          id={titleId}
          className="max-w-[340px] text-[26px] font-light leading-[1.1] tracking-[-0.025em] text-balance"
        >
          {t("settings.models.pro.headline")}
        </h2>
        {plan === "free" && (
          <p className="-mt-1 max-w-[340px] text-[12.5px] leading-normal text-white/80">
            {t("settings.models.pro.freeNote")}
          </p>
        )}

        {plan === "pro" ? (
          <p className="mt-1 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.04em] text-white/85">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]"
            />
            {proUntil
              ? t("settings.models.pro.activeUntil", { date: proUntil })
              : t("settings.models.pro.active")}
          </p>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <button
              type="button"
              onClick={onUpgrade}
              className="chrome-cta px-3.5 py-[9px] text-[13px] leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-accent"
            >
              {t("settings.models.pro.cta")}
            </button>
            <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-white/80 tabular-nums">
              {offer}
            </span>
          </div>
        )}

        {includesCloud && (
          <div
            role="group"
            aria-describedby={tileDescId}
            className="pro-zone-tile mt-1.5 flex items-center justify-between gap-4 rounded-[8px] px-3.5 py-3"
            title={t("elchiPro.card.useCloudDescription")}
          >
            <div className="flex min-w-0 flex-col gap-[3px]">
              <span className="text-[13px] font-medium leading-tight">
                {t("elchiPro.card.useCloud")}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-white/80">
                {t("settings.models.pro.useCloudOff")}
              </span>
              <span id={tileDescId} className="sr-only">
                {t("elchiPro.card.useCloudDescription")}
              </span>
            </div>
            <Switch
              tone="onBlue"
              checked={status.use_pro}
              onChange={(enabled) => setUsePro(enabled)}
              aria-label={t("elchiPro.card.useCloud")}
            />
          </div>
        )}

        {error && (
          <p role="alert" className="text-[12.5px] text-white">
            {error}
          </p>
        )}
      </div>
    </section>
  );
};
