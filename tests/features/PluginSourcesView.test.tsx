import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  PluginSettingsSectionView,
  type PluginSourceServices,
} from "@/features/plugins/components/PluginSettingsSectionView";
import { changePluginSources } from "@/features/plugins/data/sourceMutations";
const official = {
  id: "official",
  name: "Tunnelde",
  url: "https://official.example/index.json",
  enabled: true,
};
const community = {
  id: "community",
  name: "Community",
  url: "https://plugins.example.org/index.json",
  enabled: true,
};

vi.mock("@/store/marketplace", () => {
  throw new Error("View imported main source owner");
});
vi.mock("@/store/dialogs", () => {
  throw new Error("View imported main consent owner");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("View imported direct native client");
});
vi.mock("@/lib/session/clipboard", () => {
  throw new Error("View imported main clipboard owner");
});
vi.mock("@tauri-apps/api/core", () => {
  throw new Error("View imported native invoke");
});
function fixture() {
  const captured = new Map<string, unknown>();
  let sources = [official, community];
  const services: PluginSourceServices = {
    useData: () => ({ sources, configError: null, configLoading: false, ready: true }),
    readSources: () => sources,
    load: vi.fn(async () => {}),
    change: vi.fn(async (command) => {
      sources = changePluginSources(sources, command);
    }),
    test: vi.fn(async () => 4),
    confirm: vi.fn(),
    notify: vi.fn(),
    copyError: vi.fn(),
    useViewState<T>(key: string, initial: T) {
      const [value, setValue] = useState<T>(() =>
        captured.has(key) ? (captured.get(key) as T) : initial,
      );
      captured.set(key, value);
      return [value, setValue];
    },
    useBusyGuard: vi.fn(),
    renderSecurity: () => <span>Security owner slot</span>,
    renderRecovery: () => <span>Recovery owner slot</span>,
    renderRuntime: () => <span>Runtime owner slot</span>,
  };
  return {
    services,
    mount: () => render(<PluginSettingsSectionView services={services} />),
    sources: () => sources,
    replace: (next: typeof sources) => {
      sources = next;
    },
  };
}
const edit = () => fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
const input = (name: string, value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name }), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
describe("source renderer owner boundaries", () => {
  it("captures unsaved fields and test results across remount, without replaying effects", async () => {
    const owner = fixture();
    const view = owner.mount();
    edit();
    input("Source name", "Draft catalogue");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Test connection" })));
    const status = screen.getByRole("status").textContent;
    view.unmount();
    owner.mount();
    expect(screen.getByRole("textbox", { name: "Source name" })).toHaveProperty(
      "value",
      "Draft catalogue",
    );
    expect(screen.getByRole("status").textContent).toBe(status);
    expect(owner.services.test).toHaveBeenCalledTimes(1);
    expect(owner.services.change).not.toHaveBeenCalled();
    expect(screen.getByText("Recovery owner slot")).toBeTruthy();
  });
  it("drops cancelled drafts rather than restoring stale values when editing the same source again", () => {
    const owner = fixture();
    owner.mount();
    edit();
    input("Source name", "Discard me");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    edit();
    expect(screen.getByRole("textbox", { name: "Source name" })).toHaveProperty(
      "value",
      community.name,
    );
  });
  it("confirms trust before current-owner merge and preserves unrelated sources", async () => {
    const owner = fixture();
    owner.mount();
    edit();
    input("Catalogue URL", "https://changed.example/index.json");
    save();
    expect(owner.services.change).not.toHaveBeenCalled();
    const newer = { ...community, id: "other", url: "https://other.example/index.json" };
    owner.replace([...owner.sources(), newer]);
    await act(async () => vi.mocked(owner.services.confirm).mock.calls[0]![0].onConfirm());
    expect(owner.sources()).toContainEqual(newer);
    expect(owner.sources()).toContainEqual({
      ...community,
      url: "https://changed.example/index.json",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("rejects a changed identity after trust confirmation and keeps the rejected draft", async () => {
    const owner = fixture();
    owner.mount();
    edit();
    input("Catalogue URL", "https://changed.example/index.json");
    save();
    owner.replace([official, { ...community, name: "External rename" }]);
    await act(async () => vi.mocked(owner.services.confirm).mock.calls[0]![0].onConfirm());
    expect(owner.sources()[1]!.name).toBe("External rename");
    expect(screen.getByRole("textbox", { name: "Catalogue URL" })).toHaveProperty(
      "value",
      "https://changed.example/index.json",
    );
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Copy" }));
    expect(owner.services.copyError).toHaveBeenCalled();
    expect(owner.services.notify).toHaveBeenCalledWith(expect.any(String), "error");
  });
  it.each(["trust", "remove"])(
    "denies a late %s confirmation after its view is gone",
    async (kind) => {
      const owner = fixture();
      const view = owner.mount();
      if (kind === "trust") {
        edit();
        input("Catalogue URL", "https://changed.example/index.json");
        save();
      } else fireEvent.click(screen.getByRole("button", { name: "Remove source" }));
      view.unmount();
      await act(async () => vi.mocked(owner.services.confirm).mock.calls[0]![0].onConfirm());
      expect(owner.services.change).not.toHaveBeenCalled();
    },
  );
  it("does not allow stale removal, official replacement or duplicate catalogue URLs", () => {
    expect(() =>
      changePluginSources([official, { ...community, enabled: false }], {
        kind: "remove",
        expected: community,
      }),
    ).toThrow("market.sourceChanged");
    expect(() =>
      changePluginSources([official], {
        kind: "save",
        source: { ...official, name: "Hijack" },
        expected: official,
      }),
    ).toThrow("market.sourceChanged");
    expect(() =>
      changePluginSources([official], {
        kind: "save",
        source: { ...community, url: official.url },
        expected: null,
      }),
    ).toThrow("market.duplicateSource");
  });
});
