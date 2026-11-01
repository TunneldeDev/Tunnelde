import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginSettingsSection } from "@/features/plugins/PluginSettingsSection";
import { useMarketplace } from "@/store/marketplace";
import { useDialogs } from "@/store/dialogs";
import { usePluginSecurity } from "@/store/pluginSecurity";
import i18n from "@/i18n/i18n";
import { community, config, deferred, official } from "../fixtures/plugins";
const mock = vi.hoisted(() => ({ test: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: { pluginSourceTest: mock.test }, isTauri: () => false }));
vi.mock("@/lib/session/clipboard", () => ({ copyText: mock.copy }));
vi.mock("@/features/plugins/NodeRuntimeSection", () => ({ NodeRuntimeSection: () => null }));
const load = vi.fn(async () => {}),
  save = vi.fn(async () => {});
const dialog = () => screen.getByRole("dialog");
const add = () => fireEvent.click(screen.getByRole("button", { name: "Add source" }));
const input = (name: string, value: string) =>
  fireEvent.change(within(dialog()).getByRole("textbox", { name }), { target: { value } });
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en-US");
  load.mockResolvedValue(undefined);
  save.mockResolvedValue(undefined);
  mock.test.mockResolvedValue(3);
  useMarketplace.setState({
    ...useMarketplace.getInitialState(),
    config: config([official, community]),
    ready: true,
    load,
    saveSources: save,
  });
  useDialogs.setState({ dialog: { kind: "none" } });
  usePluginSecurity.setState({ ...usePluginSecurity.getInitialState(), ready: true, load });
});

describe("plugin source settings", () => {
  it("blocks mutations until configuration is ready and offers a readable retry", () => {
    useMarketplace.setState({ ready: false, configError: "Cannot read source settings" });
    render(<PluginSettingsSection />);
    expect((screen.getByRole("button", { name: "Add source" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("switch", { name: "Community" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(mock.copy).toHaveBeenCalledWith("Cannot read source settings");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(load).toHaveBeenLastCalledWith(true);
  });

  it("validates HTTPS and duplicate sources before any trust prompt or save", () => {
    render(<PluginSettingsSection />);
    add();
    input("Source name", "Other");
    input("Catalogue URL", "http://other.example/index.json");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("complete HTTPS URL");
    input("Catalogue URL", community.url);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toContain("already been added");
    expect(save).not.toHaveBeenCalled();
    expect(useDialogs.getState().dialog.kind).toBe("none");
  });

  it("asks for trust before saving and merges the latest sources after confirmation", async () => {
    render(<PluginSettingsSection />);
    add();
    input("Source name", "  Other  ");
    input("Catalogue URL", "https://other.example/index.json");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    const confirmation = useDialogs.getState().dialog;
    if (confirmation.kind !== "confirm") throw new Error("Missing source trust confirmation");
    expect(confirmation.body).toContain("https://other.example/index.json");
    expect(save).not.toHaveBeenCalled();
    const newer = {
      ...community,
      id: "newer",
      name: "Newer",
      url: "https://newer.example/index.json",
    };
    act(() => useMarketplace.setState({ config: config([official, community, newer]) }));
    await act(async () => {
      await confirmation.onConfirm();
    });
    expect(save).toHaveBeenCalledWith([
      official,
      community,
      newer,
      expect.objectContaining({ name: "Other", url: "https://other.example/index.json" }),
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("ignores cancelled trust prompts even when their callbacks arrive late", async () => {
    render(<PluginSettingsSection />);
    add();
    input("Source name", "Other");
    input("Catalogue URL", "https://other.example/index.json");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    const confirmation = useDialogs.getState().dialog;
    if (confirmation.kind !== "confirm") throw new Error("Missing source trust confirmation");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await act(async () => {
      await confirmation.onConfirm();
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("locks connection-test fields and ignores a result after closing the dialog", async () => {
    const test = deferred<number>();
    mock.test.mockReturnValue(test.promise);
    render(<PluginSettingsSection />);
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Test connection" }));
    expect(
      (within(dialog()).getByRole("textbox", { name: "Catalogue URL" }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(dialog()).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    add();
    await act(async () => {
      test.resolve(999);
      await test.promise;
    });
    expect(within(dialog()).queryByRole("status")).toBeNull();
    expect(
      (within(dialog()).getByRole("textbox", { name: "Catalogue URL" }) as HTMLInputElement).value,
    ).toBe("");
  });

  it("prevents overlapping saves and restores controls with copyable error details", async () => {
    const pending = deferred<void>();
    save.mockReturnValueOnce(pending.promise);
    render(<PluginSettingsSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Community" }));
    expect((screen.getByRole("button", { name: "Add source" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Edit source" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Tunnelde" }));
    expect(save).toHaveBeenCalledOnce();
    await act(async () => {
      pending.reject(new Error("Disk write failed"));
    });
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Add source" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.getByRole("alert").textContent).toContain("Disk write failed");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(mock.copy).toHaveBeenCalledWith("Disk write failed");
    fireEvent.click(screen.getByRole("switch", { name: "Community" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
  });
});
