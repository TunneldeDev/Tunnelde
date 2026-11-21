import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DeclarativeSecretDraftScope,
  useDeclarativeSecretDraft,
} from "@/features/plugins/declarativeSecretDrafts";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowViewRecord } from "@/lib/panels/windowViews";
afterEach(() => {
  document.body.innerHTML = "";
});
const isRecord = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((item) => typeof item === "string");

function SecretDraft() {
  const [draft, setDraft] = useDeclarativeSecretDraft<Record<string, string>>(
    "tool:secret",
    { password: "" },
    isRecord,
  );
  return (
    <input
      aria-label="Password"
      type="password"
      value={draft.password ?? ""}
      onChange={(event) => setDraft((previous) => ({ ...previous, password: event.target.value }))}
    />
  );
}

function fixture(read = Promise.resolve(JSON.stringify({ password: "restored" }))) {
  const controller = createPanelViewState();
  const record: WindowViewRecord = {
    key: "view",
    panelId: "plugin:sample:files",
    controller,
    staged: false,
    lease: { panelId: "plugin:sample:files", windowId: "main", generation: 4 },
    declarative: {
      panelId: "plugin:sample:files",
      revision: "revision-1",
      pluginId: "sample",
      runtimeId: "runtime-1",
      generation: 4,
      viewId: "files",
      title: "Sample files",
      allowFloating: true,
      renderer: "json",
    },
  };
  const readSecret = vi.fn(() => read);
  const writeSecret = vi.fn(async () => undefined);
  const client = {
    declarativeViews: vi.fn(() => ({ readSecret, writeSecret })),
  } as unknown as PanelWindowClient;
  return { controller, record, client, readSecret, writeSecret };
}

it("restores a private password draft and flushes it outside the panel capsule", async () => {
  const f = fixture();
  render(
    <PanelViewStateScope controller={f.controller}>
      <DeclarativeSecretDraftScope client={f.client} record={f.record}>
        <SecretDraft />
      </DeclarativeSecretDraftScope>
    </PanelViewStateScope>,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Password")).toHaveProperty("value", "restored"),
  );
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "changed-secret" } });
  const snapshot = await f.controller.captureAsync();
  expect(f.writeSecret).toHaveBeenLastCalledWith(
    f.record,
    "tool:secret",
    JSON.stringify({ password: "changed-secret" }),
  );
  expect(JSON.stringify(snapshot)).not.toContain("changed-secret");
  expect(JSON.stringify(snapshot)).not.toContain("restored");
});

it("ignores a late secret read after unmount", async () => {
  let resolve!: (value: string) => void;
  const read = new Promise<string>((done) => {
    resolve = done;
  });
  const f = fixture(read);
  const view = render(
    <PanelViewStateScope controller={f.controller}>
      <DeclarativeSecretDraftScope client={f.client} record={f.record}>
        <SecretDraft />
      </DeclarativeSecretDraftScope>
    </PanelViewStateScope>,
  );
  view.unmount();
  resolve(JSON.stringify({ password: "late-secret" }));
  await Promise.resolve();
  expect(JSON.stringify(f.controller.capture())).not.toContain("late-secret");
});

it("keeps a main-only secret out of the ordinary suspension snapshot", () => {
  const controller = createPanelViewState();
  const record: WindowViewRecord = {
    key: "view",
    panelId: "plugin:sample:files",
    controller,
    staged: false,
  };
  const client = {
    declarativeViews: vi.fn(() => ({ readSecret: vi.fn(), writeSecret: vi.fn() })),
  } as unknown as PanelWindowClient;
  render(
    <DeclarativeSecretDraftScope client={client} record={record}>
      <SecretDraft />
    </DeclarativeSecretDraftScope>,
  );
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "main-secret" } });
  expect(JSON.stringify(controller.capture())).not.toContain("main-secret");
});
