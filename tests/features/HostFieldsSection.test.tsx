import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { HostFieldsSection } from "@/features/hosts/HostFieldsSection";
import { api } from "@/lib/api/ipc";
import { nativeEvents } from "@/lib/events/native";
import { usePlugins } from "@/store/plugins";
import { useDialogs } from "@/store/dialogs";
import type { PluginInfo } from "@/lib/api/types";
import type { HostFieldsSnapshot } from "@/lib/hosts/fields";

vi.mock("@/lib/api/ipc", () => ({ api: { hostFields: vi.fn(), updateHostFields: vi.fn() } }));
vi.mock("@/lib/events/native", () => ({
  nativeEvents: { on: vi.fn().mockResolvedValue(() => {}) },
}));

const schema: HostFieldsSnapshot["schema"] = {
  version: 1,
  fields: [
    { id: "owner", label: "Owner", type: "text", maxLength: 8 },
    { id: "cost", label: "Cost", type: "number", minimum: 0, maximum: 100 },
    { id: "managed", label: "Managed", type: "boolean" },
    {
      id: "tier",
      label: "Tier",
      type: "select",
      options: [{ value: "prod", label: "Production" }],
    },
    { id: "__proto__", label: "Prototype key", type: "text" },
  ],
};
const snapshot = (
  values: HostFieldsSnapshot["document"]["values"] = {},
  revision = 0,
  hostId = "a",
): HostFieldsSnapshot => ({
  schema,
  document: {
    hostId,
    revision,
    schemaDigest: "digest",
    schemaVersion: 1,
    storedSchemaVersion: revision ? 1 : null,
    schemaChanged: false,
    values,
  },
});
const plugin = {
  id: "metadata",
  name: "Metadata",
  hostFields: schema,
  status: "stopped",
} as PluginInfo;
const open = async () => {
  render(<HostFieldsSection hostId="a" />);
  fireEvent.click(screen.getByText("Metadata"));
  await screen.findByLabelText("Owner");
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nativeEvents.on).mockResolvedValue(() => {});
  vi.mocked(api.hostFields).mockResolvedValue(snapshot());
  vi.mocked(api.updateHostFields).mockImplementation(async (_id, update) =>
    snapshot(update.values, update.expectedRevision + 1, update.hostId),
  );
  usePlugins.setState({ items: [plugin] });
  useDialogs.setState({ dialog: { kind: "none" } });
});

describe("host-owned plugin metadata", () => {
  it("reads a contributor only after its group is expanded", async () => {
    render(<HostFieldsSection hostId="a" />);
    expect(api.hostFields).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Metadata"));
    await screen.findByLabelText("Owner");
    expect(api.hostFields).toHaveBeenCalledTimes(1);
  });
  it("does not render an empty plugin section", () => {
    usePlugins.setState({ items: [] });
    const { container } = render(<HostFieldsSection hostId="a" />);
    expect(container.textContent).toBe("");
    expect(api.hostFields).not.toHaveBeenCalled();
  });

  it("edits stopped plugin fields with explicit revisions, preserves false/zero and treats unusual keys as data", async () => {
    vi.mocked(api.hostFields).mockResolvedValue(snapshot({ managed: false, cost: 0 }));
    await open();
    expect(screen.getByLabelText("Managed").textContent).toContain("No");
    expect((screen.getByLabelText("Cost") as HTMLInputElement).value).toBe("0");
    expect(screen.getByLabelText("Prototype key")).toHaveProperty("value", "");
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "Alice" } });
    fireEvent.change(screen.getByLabelText("Prototype key"), { target: { value: "plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved", { exact: true });
    const update = vi.mocked(api.updateHostFields).mock.calls[0]![1];
    expect(update).toMatchObject({
      hostId: "a",
      expectedRevision: 0,
      schemaDigest: "digest",
      values: { owner: "Alice", cost: 0, managed: false },
    });
    expect(Object.hasOwn(update.values, "__proto__")).toBe(true);
    expect(update.values.__proto__).toBe("plain");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("retains a conflicting draft, reports the cause and confirms before discarding", async () => {
    vi.mocked(api.updateHostFields).mockRejectedValue({
      code: "validation",
      message: "hostFields.conflict",
    });
    await open();
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
    expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("draft");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(api.hostFields).toHaveBeenCalledTimes(1);
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    if (dialog.kind === "confirm")
      await act(async () => {
        await dialog.onConfirm();
      });
    expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("");
  });

  it("blocks saving incompatible old values until explicit reconciliation and save", async () => {
    const drift = snapshot({ owner: "old", removed: "keep until saved", cost: 101 }, 3);
    drift.document.schemaChanged = true;
    drift.document.storedSchemaVersion = 0;
    vi.mocked(api.hostFields).mockResolvedValue(drift);
    await open();
    expect((await screen.findByRole("alert")).textContent).toContain("changed its field structure");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Prepare updated fields" }));
    const dialog = useDialogs.getState().dialog;
    if (dialog.kind === "confirm")
      act(() => {
        void dialog.onConfirm();
      });
    expect(api.updateHostFields).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Owner") as HTMLInputElement).value).toBe("old");
    expect((screen.getByLabelText("Cost") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updateHostFields).toHaveBeenCalledWith("metadata", {
        hostId: "a",
        expectedRevision: 3,
        schemaDigest: "digest",
        values: { owner: "old" },
      }),
    );
  });

  it("ignores a late read after switching host and releases the subscription on unmount", async () => {
    let resolve!: (value: HostFieldsSnapshot) => void;
    vi.mocked(api.hostFields).mockImplementation((_id, host) =>
      host === "a"
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve(snapshot({ owner: "Bob" }, 1, "b")),
    );
    const view = render(<HostFieldsSection hostId="a" />);
    fireEvent.click(screen.getByText("Metadata"));
    await waitFor(() => expect(api.hostFields).toHaveBeenCalledWith("metadata", "a"));
    view.rerender(<HostFieldsSection hostId="b" />);
    fireEvent.click(screen.getByText("Metadata"));
    await waitFor(() => expect(screen.getByLabelText("Owner")).toHaveProperty("value", "Bob"));
    await act(async () => {
      resolve(snapshot({ owner: "Alice" }, 1));
    });
    expect(screen.getByLabelText("Owner")).toHaveProperty("value", "Bob");
    const signal = vi.mocked(nativeEvents.on).mock.calls.at(-1)![2]!;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("keeps a dirty draft when another caller saves and removes UI on uninstall", async () => {
    const view = render(<HostFieldsSection hostId="a" />);
    fireEvent.click(screen.getByText("Metadata"));
    await screen.findByLabelText("Owner");
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "draft" } });
    const receive = vi.mocked(nativeEvents.on).mock.calls[0]![1];
    act(() => {
      void receive({ pluginId: "metadata", hostId: "a", revision: 1 });
    });
    expect(screen.getByRole("status").textContent).toContain("changed elsewhere");
    expect(api.hostFields).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Owner")).toHaveProperty("value", "draft");
    act(() => usePlugins.setState({ items: [] }));
    expect(view.container.textContent).toBe("");
  });

  it("validates numbers and character counts before saving", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Cost"), { target: { value: "101" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "😀".repeat(9) } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Cost"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "😀".repeat(8) } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false);
  });

  it("resynchronizes an initial read overtaken by a newer revision notification", async () => {
    let resolve!: (value: HostFieldsSnapshot) => void;
    vi.mocked(api.hostFields)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(snapshot({ owner: "new" }, 2));
    render(<HostFieldsSection hostId="a" />);
    fireEvent.click(screen.getByText("Metadata"));
    await waitFor(() => expect(api.hostFields).toHaveBeenCalledTimes(1));
    const receive = vi.mocked(nativeEvents.on).mock.calls[0]![1];
    await act(async () => {
      void receive({ pluginId: "metadata", hostId: "a", revision: 2 });
      resolve(snapshot({ owner: "old" }, 1));
    });
    await waitFor(() => expect(screen.getByLabelText("Owner")).toHaveProperty("value", "new"));
    expect(api.hostFields).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite typing started while an automatic refresh was in flight", async () => {
    await open();
    let resolve!: (value: HostFieldsSnapshot) => void;
    vi.mocked(api.hostFields).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const receive = vi.mocked(nativeEvents.on).mock.calls[0]![1];
    act(() => {
      void receive({ pluginId: "metadata", hostId: "a", revision: 1 });
    });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "draft" } });
    await act(async () => {
      resolve(snapshot({ owner: "external" }, 1));
    });
    expect(screen.getByLabelText("Owner")).toHaveProperty("value", "draft");
    expect(screen.getByRole("status").textContent).toContain("changed elsewhere");
  });

  it("reloads a replaced package schema while preserving unsaved user edits", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "draft" } });
    const upgraded = snapshot({ managed: true }, 1);
    upgraded.schema = { version: 2, fields: [schema.fields[2]!] };
    upgraded.document.schemaDigest = "new-digest";
    upgraded.document.schemaVersion = 2;
    vi.mocked(api.hostFields).mockResolvedValue(upgraded);
    act(() => usePlugins.setState({ items: [{ ...plugin, fingerprint: "new-package" }] }));
    await waitFor(() => expect(api.hostFields).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Owner")).toHaveProperty("value", "draft");
    expect(screen.getByRole("status").textContent).toContain("changed elsewhere");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    if (dialog.kind === "confirm")
      await act(async () => {
        await dialog.onConfirm();
      });
    await waitFor(() => expect(screen.queryByLabelText("Owner")).toBeNull());
    expect(screen.getByLabelText("Managed").textContent).toContain("Yes");
  });

  it("fences old package reads before the replacement subscription is ready", async () => {
    let resolve!: (value: HostFieldsSnapshot) => void;
    vi.mocked(api.hostFields).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<HostFieldsSection hostId="a" />);
    fireEvent.click(screen.getByText("Metadata"));
    await waitFor(() => expect(api.hostFields).toHaveBeenCalledTimes(1));
    let subscribe!: () => void;
    vi.mocked(nativeEvents.on).mockImplementationOnce(
      () =>
        new Promise((done) => {
          subscribe = () => done(() => {});
        }),
    );
    act(() => usePlugins.setState({ items: [{ ...plugin, fingerprint: "replacement" }] }));
    await act(async () => {
      resolve(snapshot({ owner: "stale" }));
    });
    expect(screen.queryByLabelText("Owner")).toBeNull();
    vi.mocked(api.hostFields).mockResolvedValue(snapshot({ owner: "new" }));
    await act(async () => {
      subscribe();
    });
    expect(await screen.findByLabelText("Owner")).toHaveProperty("value", "new");
  });
});
