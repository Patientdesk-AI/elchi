import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface ShowInDockProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/** macOS: keep Eshlik in the Dock while its window is closed. */
export const ShowInDock: React.FC<ShowInDockProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    return (
      <ToggleSwitch
        checked={getSetting("show_in_dock") ?? true}
        onChange={(enabled) => updateSetting("show_in_dock", enabled)}
        isUpdating={isUpdating("show_in_dock")}
        label={t("settings.advanced.showInDock.label")}
        description={t("settings.advanced.showInDock.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
        tooltipPosition="bottom"
      />
    );
  },
);
