import { afterEach, expect, it } from "vitest";
import { createLocalPanelWorkspace } from "@/lib/panels/localWorkspace";
import {
  endLocalPanelDrag,
  LOCAL_PANEL_MIME,
  readLocalPanelDrag,
  startLocalPanelDrag,
} from "@/lib/panels/localPanelDrag";
afterEach(endLocalPanelDrag);
it("uses an opaque document-local gesture token and validates current workspace membership", () => {
  const workspace = createLocalPanelWorkspace(),
    other = createLocalPanelWorkspace();
  workspace.reconcile(["tasks"]);
  other.reconcile(["tasks"]);
  const data = new Map<string, string>();
  const transfer = {
    setData: (key: string, value: string) => data.set(key, value),
    getData: (key: string) => data.get(key) ?? "",
  } as unknown as DataTransfer;
  startLocalPanelDrag(workspace, "tasks", transfer);
  expect(data.get(LOCAL_PANEL_MIME)).toMatch(/^[0-9a-f-]+$/);
  expect(readLocalPanelDrag(workspace, transfer)).toBe("tasks");
  expect(readLocalPanelDrag(other, transfer)).toBeNull();
  expect(readLocalPanelDrag(workspace, { getData: () => "tasks" })).toBeNull();
  workspace.reconcile([]);
  expect(readLocalPanelDrag(workspace, transfer)).toBeNull();
  workspace.reconcile(["tasks"]);
  endLocalPanelDrag();
  expect(readLocalPanelDrag(workspace, transfer)).toBeNull();
});
