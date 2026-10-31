import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import type { ModelCardStatus } from "@/components/onboarding";
import { useModelStore } from "@/stores/modelStore";
import type { ModelInfo } from "@/bindings";
import { ElchiProCard } from "./ElchiProCard";
import { LocalModelCard } from "./LocalModelCard";
import { useElchiPro } from "@/hooks/useElchiPro";

/**
 * Eshlik has two models: Duyu Pro in the cloud (the trial and Eshlik Pro) and
 * Duyu-small on this computer, which is always there as the fallback. The
 * page title and summary come from the settings shell; this is the body.
 */
export const ModelsSettings: React.FC = () => {
  const { t } = useTranslation();
  const [switchingModelId, setSwitchingModelId] = useState<string | null>(null);
  const {
    models,
    currentModel,
    downloadingModels,
    downloadProgress,
    downloadStats,
    verifyingModels,
    extractingModels,
    loading,
    downloadModel,
    cancelDownload,
    selectModel,
    deleteModel,
  } = useModelStore();
  // While Duyu Pro transcribes, Duyu-small is the fallback, not the engine.
  const cloudActive = useElchiPro().status?.cloud_active ?? false;

  const getModelStatus = (modelId: string): ModelCardStatus => {
    if (modelId in extractingModels) {
      return "extracting";
    }
    if (modelId in verifyingModels) {
      return "verifying";
    }
    if (modelId in downloadingModels) {
      return "downloading";
    }
    if (switchingModelId === modelId) {
      return "switching";
    }
    const model = models.find((m: ModelInfo) => m.id === modelId);
    // A stale persisted selection must never make a missing model look Active.
    // Catalog models without files should offer their recovery action instead.
    if (!model?.is_downloaded) {
      return "downloadable";
    }
    if (modelId === currentModel) {
      return "active";
    }
    return "available";
  };

  const handleModelSelect = async (modelId: string) => {
    setSwitchingModelId(modelId);
    try {
      await selectModel(modelId);
    } finally {
      setSwitchingModelId(null);
    }
  };

  const handleModelDownload = async (modelId: string) => {
    await downloadModel(modelId);
  };

  const handleModelDelete = async (modelId: string) => {
    const model = models.find((m: ModelInfo) => m.id === modelId);
    const modelName = model?.name || modelId;
    const isActive = modelId === currentModel;

    const confirmed = await ask(
      isActive
        ? t("settings.models.deleteActiveConfirm", { modelName })
        : t("settings.models.deleteConfirm", { modelName }),
      {
        title: t("settings.models.deleteTitle"),
        kind: "warning",
      },
    );

    if (confirmed) {
      try {
        await deleteModel(modelId);
      } catch (err) {
        console.error(`Failed to delete model ${modelId}:`, err);
      }
    }
  };

  const handleModelCancel = async (modelId: string) => {
    try {
      await cancelDownload(modelId);
    } catch (err) {
      console.error(`Failed to cancel download for ${modelId}:`, err);
    }
  };

  // Legacy (.bin/ONNX blob) entries stay hidden unless already on disk.
  const localModels = models.filter(
    (model: ModelInfo) =>
      !(
        typeof model.source === "object" &&
        "Url" in model.source &&
        !model.is_downloaded
      ),
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full motion-safe:animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-[22px]">
      <ElchiProCard />

      <section aria-labelledby="local-models-title" className="space-y-2.5">
        <div className="flex items-baseline justify-between gap-4 px-0.5">
          <h2 id="local-models-title" className="label-mono tracking-[0.12em]">
            {t("settings.models.onDevice.title")}
          </h2>
          <span className="label-mono tracking-[0.12em] truncate">
            {cloudActive
              ? t("settings.models.onDevice.hintFallback")
              : t("settings.models.onDevice.hint")}
          </span>
        </div>
        <div className="flex flex-col gap-2.5">
          {localModels.map((model: ModelInfo) => (
            <LocalModelCard
              key={model.id}
              model={model}
              status={getModelStatus(model.id)}
              cloudActive={cloudActive}
              progress={downloadProgress[model.id]}
              speed={downloadStats[model.id]?.speed}
              onSelect={handleModelSelect}
              onDownload={handleModelDownload}
              onDelete={handleModelDelete}
              onCancel={handleModelCancel}
            />
          ))}
        </div>
      </section>
    </div>
  );
};
