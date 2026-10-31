import React from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { SettingContainer } from "../../ui/SettingContainer";
import { Button } from "../../ui/Button";
import { ShowWhatsNewOnUpdate } from "../ShowWhatsNewOnUpdate";
import { LogDirectory } from "../debug";
import UpdateChecker, { useUpdater } from "../../update-checker";
import { SELF_UPDATE_AVAILABLE } from "../../../lib/constants/updater";

/**
 * Hakkında: opened from the version line in the rail. The version and the
 * update controls, release notes, logs, and the projects Eshlik builds on.
 */
export const AboutSettings: React.FC = () => {
  const { t } = useTranslation();
  const { version } = useUpdater();

  return (
    <div className="flex flex-col gap-[22px]">
      <SettingsGroup title={t("settings.about.title")}>
        <SettingContainer
          title={t("settings.about.version.title")}
          description={t("settings.about.version.description")}
          grouped
        >
          <span className="font-mono text-[11px] tracking-[0.04em] text-text/70">
            {version ? `v${version}` : ""}
          </span>
        </SettingContainer>
        {SELF_UPDATE_AVAILABLE && (
          <div className="px-[18px] py-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[13.5px] font-normal">
              {t("settings.about.updates.title")}
            </h3>
            <UpdateChecker />
          </div>
        )}
        <ShowWhatsNewOnUpdate descriptionMode="tooltip" grouped />
        <LogDirectory grouped />
      </SettingsGroup>

      <SettingsGroup title={t("settings.about.acknowledgments.title")}>
        <SettingContainer
          title={t("settings.about.acknowledgments.handy.title")}
          description={t("settings.about.acknowledgments.handy.description")}
          grouped
          layout="stacked"
          descriptionMode="inline"
        >
          <div className="flex flex-col items-start gap-3">
            <p className="text-[12px] leading-relaxed text-mid-gray">
              {t("settings.about.acknowledgments.handy.details")}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                openUrl("https://github.com/cjpais/Handy").catch((error) =>
                  console.error("Failed to open Handy repository:", error),
                )
              }
            >
              {t("settings.about.acknowledgments.handy.button")}
            </Button>
          </div>
        </SettingContainer>
        <SettingContainer
          title={t("settings.about.acknowledgments.ggml.title")}
          description={t("settings.about.acknowledgments.ggml.description")}
          grouped
          layout="stacked"
          descriptionMode="inline"
        >
          <p className="text-[12px] leading-relaxed text-mid-gray">
            {t("settings.about.acknowledgments.ggml.details")}
          </p>
        </SettingContainer>
      </SettingsGroup>
    </div>
  );
};
