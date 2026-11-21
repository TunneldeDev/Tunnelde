import type { WindowModelAppearance } from "@/app/panelReadModels";
import type { Host } from "@/lib/api/types";
import type { HostPanelTarget } from "../panel/protocol";
import type { ForwardingReadData } from "@/features/forwarding/data/readModel";
export interface HostDetailModel extends WindowModelAppearance {
  detail: {
    host: Host | null;
    target: HostPanelTarget | null;
    groupName?: string;
    hostCount: number;
    allowMove: boolean;
    forwarding: ForwardingReadData;
  };
}
