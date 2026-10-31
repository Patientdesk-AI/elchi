import React from "react";
import { useTranslation } from "react-i18next";
import { type } from "@tauri-apps/plugin-os";
import { MicrophoneSelector } from "../MicrophoneSelector";
import { ChannelSelector } from "../ChannelSelector";
import { ShortcutInput } from "../ShortcutInput";
import { SettingsGroup } from "../../ui/SettingsGroup";
import { OutputDeviceSelector } from "../OutputDeviceSelector";
import { ShortcutActivationSetting } from "../ShortcutActivation";
import { AudioFeedback } from "../AudioFeedback";
import { useSettings } from "../../../hooks/useSettings";
import { VolumeSlider } from "../VolumeSlider";
import { MuteWhileRecording } from "../MuteWhileRecording";
import { SmartFormatting } from "../SmartFormatting";
import { FillerWordRemoval } from "../FillerWordRemoval";
import { LanguageSelector } from "../LanguageSelector";
import { TranslateToEnglish } from "../TranslateToEnglish";
import { ThemeSelector } from "../ThemeSelector";
import { AppLanguageSelector } from "../AppLanguageSelector";
import { useModelStore } from "../../../stores/modelStore";
import type { ModelInfo } from "@/bindings";

/**
 * Genel (design frame 3b): the shortcut, the microphone and sounds, what
 * happens to the text, and how Eshlik looks.
 */
export const GeneralSettings: React.FC = () => {
  const { t } = useTranslation();
  const { audioFeedbackEnabled, getSetting } = useSettings();
  const { currentModel, models } = useModelStore();
  const isLinux = type() === "linux";

  const model = models.find((m: ModelInfo) => m.id === currentModel);
  const microphone = getSetting("selected_microphone");
  const micHint =
    microphone && microphone !== "default" && microphone !== "Default"
      ? microphone
      : undefined;

  return (
    <div className="flex flex-col gap-[22px]">
      <SettingsGroup title={t("settings.general.groups.shortcut")}>
        <ShortcutInput shortcutId="transcribe" grouped />
        <ShortcutActivationSetting descriptionMode="inline" grouped />
        {/* Cancel shortcut remains hidden on Linux because of dynamic shortcut instability. */}
        {!isLinux && <ShortcutInput shortcutId="cancel" grouped />}
      </SettingsGroup>

      <SettingsGroup title={t("settings.sound.title")} hint={micHint}>
        <MicrophoneSelector descriptionMode="tooltip" grouped />
        <ChannelSelector descriptionMode="tooltip" grouped />
        <MuteWhileRecording descriptionMode="tooltip" grouped />
        <AudioFeedback grouped />
        <OutputDeviceSelector
          descriptionMode="tooltip"
          grouped
          disabled={!audioFeedbackEnabled}
        />
        <VolumeSlider disabled={!audioFeedbackEnabled} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.groups.output")}>
        <SmartFormatting descriptionMode="tooltip" grouped />
        <FillerWordRemoval descriptionMode="tooltip" grouped />
        {model?.supports_language_selection && (
          <LanguageSelector
            title={t("settings.general.language.modelTitle", {
              model: model.name,
            })}
            descriptionMode="tooltip"
            grouped
            supportedLanguages={model.supported_languages}
            supportsLanguageDetection={model.supports_language_detection}
          />
        )}
        {model?.supports_translation && (
          <TranslateToEnglish descriptionMode="tooltip" grouped />
        )}
      </SettingsGroup>

      <SettingsGroup title={t("settings.general.groups.appearance")}>
        <ThemeSelector descriptionMode="tooltip" grouped />
        <AppLanguageSelector descriptionMode="tooltip" grouped />
      </SettingsGroup>
    </div>
  );
};
