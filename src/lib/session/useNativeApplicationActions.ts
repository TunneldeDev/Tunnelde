import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import { beforeWindowReload } from "./reload";
import { requestApplicationAction } from "./restart";

interface NativeAction {
  owner: string;
  id: string;
  action: "restart" | "quit";
}

/** The listener owns the native intent only for this document. A suspended
 * WebView is recreated before its confirmation and final draft checkpoint. */
export function useNativeApplicationActions(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const owner = crypto.randomUUID();
    let alive = true;
    let release: (() => Promise<void>) | undefined;
    const subscribing = (async () => {
      const stop = await listen<NativeAction>("ui://application-action", ({ payload }) => {
        if (!alive || payload.owner !== owner) return;
        if (payload.action !== "restart" && payload.action !== "quit") return;
        requestApplicationAction(payload.action, () =>
          invoke("application_action_finish", { owner, id: payload.id }),
        );
      });
      const dispose = async () => {
        await invoke("application_action_release", { owner });
        await stop();
      };
      try {
        await invoke("application_action_claim", { owner });
      } catch (error) {
        await stop();
        throw error;
      }
      if (alive) release = dispose;
      else await dispose();
    })();
    const removePreparation = beforeWindowReload(async () => {
      await subscribing;
      await release?.();
      release = undefined;
    });
    void subscribing.catch((error) => {
      if (alive) toast(translateError(error), "error");
    });
    return () => {
      alive = false;
      removePreparation();
      void release?.().catch(() => undefined);
    };
  }, []);
}
