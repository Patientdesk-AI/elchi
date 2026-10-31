import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useElchiPro } from "../../hooks/useElchiPro";

interface SmartFormattingProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/** Eshlik's formatter (on every plan): dictation laid out before it is pasted. */
export const SmartFormatting: React.FC<SmartFormattingProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { status, setFormat } = useElchiPro();

    return (
      <ToggleSwitch
        checked={status?.format ?? true}
        onChange={(enabled) => setFormat(enabled)}
        isUpdating={status === null}
        label={t("settings.general.smartFormatting.title")}
        description={t("settings.general.smartFormatting.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);
