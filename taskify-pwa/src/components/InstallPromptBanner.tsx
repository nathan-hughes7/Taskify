import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

type BeforeInstallPromptEvent = Event & {
  readonly platforms?: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt: () => Promise<void>;
};

function isAndroidDevice() {
  if (typeof navigator === "undefined") return false;
  return /android/i.test(navigator.userAgent || "");
}

function isStandaloneMode() {
  if (typeof window === "undefined") return false;
  if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) {
    return true;
  }
  // iOS Safari
  return (navigator as any).standalone === true;
}

export function InstallPromptBanner() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [standalone, setStandalone] = useState(() => isStandaloneMode());
  const android = useMemo(() => isAndroidDevice(), []);

  useEffect(() => {
    if (!android) return;

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDismissed(false);
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setDismissed(true);
      setStandalone(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, [android]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(display-mode: standalone)");
    const listener = (event: MediaQueryListEvent) => setStandalone(event.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  if (!android || standalone || dismissed || !deferredPrompt) {
    return null;
  }

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setDeferredPrompt(null);
        setDismissed(true);
        setStandalone(true);
      } else {
        setDismissed(true);
        setDeferredPrompt(null);
      }
    } catch {
      setDismissed(true);
      setDeferredPrompt(null);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    setDeferredPrompt(null);
  };

  return createPortal(
    <div className="fixed bottom-4 left-4 right-4 z-[60] md:left-auto md:right-6 md:w-80">
      <div className="glass-panel border border-surface shadow-xl p-4 rounded-2xl space-y-3">
        <div className="text-sm font-semibold text-primary">Install Taskify</div>
        <p className="text-xs text-secondary">
          Add Taskify to your home screen for faster access and an app-like experience.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="accent-button pressable flex-1 justify-center"
            onClick={handleInstallClick}
          >
            Install
          </button>
          <button
            type="button"
            className="ghost-button button-sm pressable"
            onClick={handleDismiss}
          >
            Not now
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
