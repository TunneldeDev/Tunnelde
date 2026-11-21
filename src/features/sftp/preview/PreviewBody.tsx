import { PanelViewStateGroup } from "@/lib/panels/viewState";
import type { ReactNode } from "react";

/** All renderer-local state is qualified by the immutable read attempt. A new
 * target/provider/retry must never inherit a previous file's page or caret. */
export function PreviewBody({ attemptId, children }: { attemptId: string; children: ReactNode }) {
  return (
    <PanelViewStateGroup key={attemptId} name={`preview:${attemptId}`}>
      {children}
    </PanelViewStateGroup>
  );
}
