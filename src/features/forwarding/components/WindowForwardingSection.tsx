import { WindowForwardingSurface } from "./WindowForwardingSurface";
import type { WindowForwardingViewOwner } from "../runtime/windowProviderSource";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelLease } from "@/lib/panels/windowProtocol";
import { ForwardingHostSection, type ForwardingHostSectionProps } from "../ForwardingSection";
import { ForwardingActionScope } from "../runtime/actionScope";
import type { createWindowForwardingActions } from "../runtime/windowActions";
import { WindowForwardingConfirmationScope } from "./WindowForwardingConfirmationScope";
import { WindowForwardingConnectDialog } from "./WindowForwardingConnectDialog";

type Props = Pick<ForwardingHostSectionProps, "host" | "embedded"> &
  (
    | { owner: WindowForwardingViewOwner; renderSurface?: never }
    | { owner?: never; renderSurface: ForwardingHostSectionProps["renderSurface"] }
  ) & {
    client: PanelWindowClient;
    lease: PanelLease;
    service: ReturnType<typeof createWindowForwardingActions>;
  };
/** Native host section composition. Parent supplies the authoritative read
 * model and selected native provider surface, and owns service disposal. No
 * main stores/provider runtime or main-document connection dialog are used. */
export function WindowForwardingSection({
  client,
  lease,
  service,
  owner,
  renderSurface,
  ...props
}: Props) {
  return (
    <ForwardingActionScope value={service.actions}>
      <WindowForwardingConfirmationScope client={client} lease={lease}>
        <ForwardingHostSection
          {...props}
          renderSurface={
            renderSurface ??
            ((surface) => <WindowForwardingSurface {...surface} owner={owner!} service={service} />)
          }
          renderConnection={(connection, controller) => {
            const [first, ...following] = connection.rules;
            if (!first) throw new Error("forward.missing");
            return (
              <WindowForwardingConnectDialog
                client={client}
                lease={lease}
                rule={first}
                followingRules={following}
                provider={service.providerFor(connection.authority)}
                onClose={controller.closeConnection}
                onBatchComplete={(result) => controller.batchCompleted(connection, result)}
                onConnected={(session) => controller.connected(connection, session)}
              />
            );
          }}
        />
      </WindowForwardingConfirmationScope>
    </ForwardingActionScope>
  );
}
