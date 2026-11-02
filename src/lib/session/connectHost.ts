import { translateError } from "@/lib/api/errors";
import type { Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";

/** The backend verifies the actual server key before authenticating with the vault. */
export async function connectHostDirectly(host: Host): Promise<void> {
  const session = await useSsh
    .getState()
    .connect({ hostId: host.id, cols: 120, rows: 32 }, (error) =>
      useDialogs.getState().openConnect(host, "terminal", "connect", translateError(error)),
    );
  if (session) useWorkspace.getState().openTerminal(session);
}
