import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { platform } from "@tauri-apps/plugin-os";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  checkAccessibilityPermission,
  requestAccessibilityPermission,
  checkMicrophonePermission,
  requestMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import { toast } from "sonner";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  GhostButton,
  OnboardingShell,
  PrimaryButton,
  ProgressDashes,
} from "./OnboardingShell";
import { Keyboard, Mic, Check, Loader2, type LucideIcon } from "lucide-react";

interface AccessibilityOnboardingProps {
  onComplete: () => void;
  preview?: boolean;
}

type PermissionStatus = "checking" | "needed" | "waiting" | "granted";
type PermissionPlatform = "macos" | "windows" | "other";

interface PermissionsState {
  accessibility: PermissionStatus;
  microphone: PermissionStatus;
}

const AccessibilityOnboarding: React.FC<AccessibilityOnboardingProps> = ({
  onComplete,
  preview = false,
}) => {
  const { t } = useTranslation();
  const refreshAudioDevices = useSettingsStore(
    (state) => state.refreshAudioDevices,
  );
  const refreshOutputDevices = useSettingsStore(
    (state) => state.refreshOutputDevices,
  );
  const [permissionPlatform, setPermissionPlatform] =
    useState<PermissionPlatform | null>(null);
  const [permissions, setPermissions] = useState<PermissionsState>({
    accessibility: "checking",
    microphone: "checking",
  });
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorCountRef = useRef<number>(0);
  const MAX_POLLING_ERRORS = 3;
  // A permission still unconfirmed this long after asking gets the way out
  // below (reset the stale entry, or restart) instead of a spinner forever.
  const STUCK_AFTER_MS = 6000;
  const [stuck, setStuck] = useState(false);

  const isMacOS = permissionPlatform === "macos";
  const isWindows = permissionPlatform === "windows";
  const showMicrophonePermission = isMacOS || isWindows;
  const showAccessibilityPermission = isMacOS;

  const allGranted = isMacOS
    ? permissions.accessibility === "granted" &&
      permissions.microphone === "granted"
    : isWindows
      ? permissions.microphone === "granted"
      : true;

  // The parent passes a fresh onComplete each render. Reading it through a ref
  // keeps the mount check below from re-running on every parent render, and
  // completedRef makes completion one-shot: each extra call used to start
  // another finishOnboarding (and another background model download).
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const completedRef = useRef(false);

  const completeOnboarding = useCallback(async () => {
    if (completedRef.current) return;
    completedRef.current = true;
    await Promise.all([refreshAudioDevices(), refreshOutputDevices()]);
    timeoutRef.current = setTimeout(() => onCompleteRef.current(), 300);
  }, [refreshAudioDevices, refreshOutputDevices]);

  const hasWindowsMicrophoneAccess = useCallback(async (): Promise<boolean> => {
    const microphoneStatus =
      await commands.getWindowsMicrophonePermissionStatus();

    if (!microphoneStatus.supported) {
      return true;
    }

    return microphoneStatus.overall_access !== "denied";
  }, []);

  // Check platform and permission status on mount
  useEffect(() => {
    const currentPlatform = platform();
    const nextPlatform: PermissionPlatform =
      currentPlatform === "macos"
        ? "macos"
        : currentPlatform === "windows"
          ? "windows"
          : "other";

    setPermissionPlatform(nextPlatform);

    // Debug previews are intentionally inert: show the permission request UI
    // without checking or changing operating-system permissions.
    if (preview) {
      setPermissions({
        accessibility: nextPlatform === "macos" ? "needed" : "granted",
        microphone: nextPlatform === "other" ? "granted" : "needed",
      });
      return;
    }

    // Skip immediately on unsupported platforms
    if (nextPlatform === "other") {
      if (!completedRef.current) {
        completedRef.current = true;
        onCompleteRef.current();
      }
      return;
    }

    const checkInitial = async () => {
      if (nextPlatform === "macos") {
        try {
          const [accessibilityGranted, microphoneGranted] = await Promise.all([
            checkAccessibilityPermission(),
            checkMicrophonePermission(),
          ]);

          // If accessibility is granted, initialize Enigo and shortcuts
          if (accessibilityGranted) {
            try {
              await Promise.all([
                commands.initializeEnigo(),
                commands.initializeShortcuts(),
              ]);
            } catch (e) {
              console.warn("Failed to initialize after permission grant:", e);
            }
          }

          const newState: PermissionsState = {
            accessibility: accessibilityGranted ? "granted" : "needed",
            microphone: microphoneGranted ? "granted" : "needed",
          };

          setPermissions(newState);

          if (accessibilityGranted && microphoneGranted) {
            await completeOnboarding();
          }
        } catch (error) {
          console.error("Failed to check macOS permissions:", error);
          toast.error(t("onboarding.permissions.errors.checkFailed"));
          setPermissions({
            accessibility: "needed",
            microphone: "needed",
          });
        }

        return;
      }

      try {
        const microphoneGranted = await hasWindowsMicrophoneAccess();

        setPermissions({
          accessibility: "granted",
          microphone: microphoneGranted ? "granted" : "needed",
        });

        if (microphoneGranted) {
          await completeOnboarding();
        }
      } catch (error) {
        console.warn("Failed to check Windows microphone permissions:", error);
        setPermissions({
          accessibility: "granted",
          microphone: "granted",
        });
        await completeOnboarding();
      }
    };

    checkInitial();
  }, [completeOnboarding, hasWindowsMicrophoneAccess, preview, t]);

  // Polling for permissions after user clicks a button
  const startPolling = useCallback(() => {
    if (pollingRef.current || permissionPlatform === null) return;

    pollingRef.current = setInterval(async () => {
      try {
        if (permissionPlatform === "windows") {
          const microphoneGranted = await hasWindowsMicrophoneAccess();

          if (microphoneGranted) {
            setPermissions((prev) => ({ ...prev, microphone: "granted" }));

            if (pollingRef.current) {
              clearInterval(pollingRef.current);
              pollingRef.current = null;
            }

            await completeOnboarding();
          }

          errorCountRef.current = 0;
          return;
        }

        const [accessibilityGranted, microphoneGranted] = await Promise.all([
          checkAccessibilityPermission(),
          checkMicrophonePermission(),
        ]);

        setPermissions((prev) => {
          const newState = { ...prev };

          if (accessibilityGranted && prev.accessibility !== "granted") {
            newState.accessibility = "granted";
            // Initialize Enigo and shortcuts when accessibility is granted
            Promise.all([
              commands.initializeEnigo(),
              commands.initializeShortcuts(),
            ]).catch((e) => {
              console.warn("Failed to initialize after permission grant:", e);
            });
          }

          if (microphoneGranted && prev.microphone !== "granted") {
            newState.microphone = "granted";
          }

          return newState;
        });

        // If both granted, stop polling, refresh audio devices, and proceed
        if (accessibilityGranted && microphoneGranted) {
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          await completeOnboarding();
        }

        // Reset error count on success
        errorCountRef.current = 0;
      } catch (error) {
        console.error("Error checking permissions:", error);
        errorCountRef.current += 1;

        if (errorCountRef.current >= MAX_POLLING_ERRORS) {
          // Stop polling after too many consecutive errors
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
          }
          toast.error(t("onboarding.permissions.errors.checkFailed"));
        }
      }
    }, 1000);
  }, [completeOnboarding, hasWindowsMicrophoneAccess, permissionPlatform, t]);

  // Cleanup polling and timeouts on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleGrantAccessibility = async () => {
    if (preview) return;

    try {
      await requestAccessibilityPermission();
      setPermissions((prev) => ({ ...prev, accessibility: "waiting" }));
      startPolling();
    } catch (error) {
      console.error("Failed to request accessibility permission:", error);
      toast.error(t("onboarding.permissions.errors.requestFailed"));
    }
  };

  const handleGrantMicrophone = async () => {
    if (preview) return;

    try {
      if (isWindows) {
        await commands.openMicrophonePrivacySettings();
      } else {
        await requestMicrophonePermission();
      }

      setPermissions((prev) => ({ ...prev, microphone: "waiting" }));
      startPolling();
    } catch (error) {
      console.error("Failed to request microphone permission:", error);
      toast.error(t("onboarding.permissions.errors.requestFailed"));
    }
  };

  const waiting =
    permissions.accessibility === "waiting" ||
    permissions.microphone === "waiting";
  useEffect(() => {
    if (!waiting) {
      setStuck(false);
      return;
    }
    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  // macOS can keep an entry from an earlier, differently signed Eshlik: it looks
  // switched on in System Settings but is refused. Clearing it makes the next
  // "Allow" add a fresh one.
  const handleReset = async () => {
    const accessibility = permissions.accessibility !== "granted";
    const microphone = permissions.microphone !== "granted";
    const result = await commands.resetMacosPermissions(
      isMacOS && accessibility,
      isMacOS && microphone,
    );
    if (result.status === "error") {
      console.error("Failed to reset permissions:", result.error);
      toast.error(t("onboarding.permissions.stuck.resetFailed"));
      return;
    }
    setPermissions((prev) => ({
      accessibility: prev.accessibility === "granted" ? "granted" : "needed",
      microphone: prev.microphone === "granted" ? "granted" : "needed",
    }));
    setStuck(false);
    toast.success(t("onboarding.permissions.stuck.resetDone"));
  };

  const isChecking =
    permissionPlatform === null ||
    (isMacOS &&
      permissions.accessibility === "checking" &&
      permissions.microphone === "checking") ||
    (isWindows && permissions.microphone === "checking");

  // Still checking platform/initial permissions
  if (isChecking) {
    return (
      <div className="onb-pane h-screen w-full flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-mid-gray" />
      </div>
    );
  }

  const shown: PermissionStatus[] = [
    ...(showMicrophonePermission ? [permissions.microphone] : []),
    ...(showAccessibilityPermission ? [permissions.accessibility] : []),
  ];
  const grantedCount = shown.filter((s) => s === "granted").length;

  return (
    <OnboardingShell
      seed={23}
      centered
      stepLabel={t("onboarding.layout.setupPermissions")}
      title={
        allGranted
          ? t("onboarding.permissions.allGranted")
          : t("onboarding.permissions.title", { count: shown.length })
      }
      body={
        showAccessibilityPermission
          ? t("onboarding.permissions.description")
          : t("onboarding.permissions.descriptionMicrophone")
      }
      footer={
        <>
          <ProgressDashes
            on={shown.map((s) => s === "granted")}
            label={t("onboarding.permissions.progress", {
              granted: grantedCount,
              total: shown.length,
            })}
          />
          {!allGranted && (
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)] text-end">
              {isWindows
                ? t("onboarding.permissions.noteWindows")
                : t("onboarding.permissions.note")}
            </span>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {stuck && !allGranted && (
          <section
            role="status"
            className="steel-panel flex flex-col gap-2.5 px-[22px] py-4"
          >
            <h2 className="text-[14px] font-medium leading-tight">
              {t("onboarding.permissions.stuck.title")}
            </h2>
            <p className="text-[12.5px] leading-normal text-mid-gray">
              {isMacOS
                ? t("onboarding.permissions.stuck.body")
                : t("onboarding.permissions.stuck.bodyRestart")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {isMacOS && (
                <PrimaryButton onClick={handleReset} arrow={false}>
                  {t("onboarding.permissions.stuck.reset")}
                </PrimaryButton>
              )}
              <GhostButton onClick={() => relaunch()}>
                {t("onboarding.permissions.stuck.restart")}
              </GhostButton>
            </div>
          </section>
        )}
        {showMicrophonePermission && (
          <PermissionCard
            icon={Mic}
            title={t("onboarding.permissions.microphone.title")}
            description={t("onboarding.permissions.microphone.description")}
            status={permissions.microphone}
            actionLabel={
              isWindows
                ? t("onboarding.permissions.openSettings")
                : t("onboarding.permissions.grant")
            }
            onAction={handleGrantMicrophone}
          />
        )}
        {showAccessibilityPermission && (
          <PermissionCard
            icon={Keyboard}
            title={t("onboarding.permissions.accessibility.title")}
            description={t("onboarding.permissions.accessibility.description")}
            status={permissions.accessibility}
            actionLabel={t("onboarding.permissions.grant")}
            onAction={handleGrantAccessibility}
          />
        )}
      </div>
    </OnboardingShell>
  );
};

interface PermissionCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  status: PermissionStatus;
  actionLabel: string;
  onAction: () => void;
}

/** One permission as a steel card: what it is for, then grant / waiting / granted. */
const PermissionCard: React.FC<PermissionCardProps> = ({
  icon: Icon,
  title,
  description,
  status,
  actionLabel,
  onAction,
}) => {
  const { t } = useTranslation();
  const granted = status === "granted";
  return (
    <section className="steel-panel grid grid-cols-[44px_1fr_auto] items-center gap-[18px] px-[22px] py-5">
      {granted ? (
        <span className="gem rounded-[11px] w-11 h-11 flex items-center justify-center">
          <Check className="w-[18px] h-[18px]" aria-hidden={true} />
        </span>
      ) : (
        <span className="steel-chip rounded-[11px] w-11 h-11 flex items-center justify-center text-mid-gray">
          <Icon className="w-[18px] h-[18px]" aria-hidden={true} />
        </span>
      )}
      <div className="flex flex-col gap-1 min-w-0">
        <h2 className="text-[15px] font-medium leading-tight">{title}</h2>
        <p className="text-[12.5px] leading-normal text-mid-gray">
          {description}
        </p>
      </div>
      {granted ? (
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-accent-soft">
          {t("onboarding.permissions.granted")}
        </span>
      ) : status === "waiting" ? (
        <span
          role="status"
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-mid-gray"
        >
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
          {t("onboarding.permissions.waiting")}
        </span>
      ) : (
        <PrimaryButton onClick={onAction} arrow={false}>
          {actionLabel}
        </PrimaryButton>
      )}
    </section>
  );
};

export default AccessibilityOnboarding;
