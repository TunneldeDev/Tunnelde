import { SftpPageView } from "./SftpPageView";
import { mainFilePageServices } from "./mainFilePageServices";
import type { FilePaneOptions } from "@/store/workspace";
export interface SftpPageProps {
  sessionId: string;
  single?: FilePaneOptions;
  scopeId?: string;
  tabId?: string;
}
export function SftpPage(props: SftpPageProps) {
  return <SftpPageView {...props} services={mainFilePageServices} />;
}
