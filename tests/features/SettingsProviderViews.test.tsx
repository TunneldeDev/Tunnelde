import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  UiProviderSettingsView,
  type ProviderSettingsRow,
} from "@/features/plugins/components/UiProviderSettingsView";
import { MountHostDetailsSettingsView } from "@/features/plugins/components/MountHostDetailsSettingsView";
import { AboutPageView } from "@/features/about/AboutPageView";
import type { SettingsControlState } from "@/features/settings/components/controlState";

vi.mock("@/store/settings", () => {
  throw new Error("Provider settings view imported main settings");
});
vi.mock("@/store/plugins", () => {
  throw new Error("Provider settings view imported main runtime");
});
vi.mock("@/store/workspace", () => {
  throw new Error("Provider settings view imported main workspace");
});
vi.mock("@/lib/extensions/frontendRuntime", () => {
  throw new Error("Provider settings view imported singleton frontend runtime");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("Provider settings view imported direct IPC");
});
function fixture() {
  const captured = new Map<string, unknown>();
  const useViewState: SettingsControlState = <T,>(key: string, initial: T) => {
    const [value, setValue] = useState<T>(() =>
      captured.has(key) ? (captured.get(key) as T) : initial,
    );
    captured.set(key, value);
    return [value, setValue];
  };
  return { useViewState, useBusyGuard: vi.fn(), captured };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("provider settings independent production views", () => {
  it("shows missing providers without activating anything and delegates only the selected target", () => {
    const hooks = fixture();
    const choose = vi.fn(async () => {});
    const rows: ProviderSettingsRow[] = [
      { target: "terminal", selected: { pluginId: "missing", viewId: "terminal" }, candidates: [] },
      {
        target: "preferences",
        selected: null,
        candidates: [{ value: '["example","settings"]', label: "Example · Settings" }],
      },
    ];
    render(<UiProviderSettingsView {...hooks} rows={rows} busy={false} expanded choose={choose} />);
    expect(screen.getByText("1 customized · 1 unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Terminal" }).textContent).toContain("Unavailable");
    expect(choose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("option", { name: "Built-in" }));
    expect(choose).toHaveBeenCalledWith("terminal", "");
    expect(rows[0]?.candidates).toEqual([]);
  });

  it("restores disclosure capture and disables provider changes while the owner is busy", () => {
    const hooks = fixture();
    hooks.captured.set("settings:providers:open", true);
    const choose = vi.fn(async () => {});
    const { container } = render(
      <UiProviderSettingsView
        {...hooks}
        rows={[{ target: "terminal", selected: null, candidates: [] }]}
        busy
        choose={choose}
      />,
    );
    expect(container.querySelector("details")?.open).toBe(true);
    expect(screen.getByRole("button", { name: "Terminal" })).toHaveProperty("disabled", true);
    expect(hooks.useBusyGuard).toHaveBeenCalledWith(true);
    expect(choose).not.toHaveBeenCalled();
  });

  it("preserves the unavailable mount contributor and delegates explicit disabling", () => {
    const hooks = fixture();
    const choose = vi.fn();
    const candidates = [{ value: '["sshfs","mounts"]', label: "SSHFS · Mounts" }];
    render(
      <MountHostDetailsSettingsView
        value='["old","mounts"]'
        candidates={candidates}
        unavailableName="old"
        busy={false}
        choose={choose}
        useBusyGuard={hooks.useBusyGuard}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("providers.hostMounts") }));
    expect(screen.getByRole("option", { name: "old (Unavailable)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Disabled" }));
    expect(choose).toHaveBeenCalledWith("");
    expect(candidates).toHaveLength(1);
  });

  it("renders app metadata and captures local notices while external destinations remain owner-named actions", () => {
    const hooks = fixture();
    const openLink = vi.fn();
    const info = { version: "2.0.0", tauriVersion: "2.12.4", os: "macos", arch: "aarch64" };
    const view = render(<AboutPageView embedded {...hooks} info={info} openLink={openLink} />);
    expect(screen.getByText(/2\.0\.0.*Tauri.*macos\/aarch64/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Source code" }));
    expect(openLink).toHaveBeenCalledWith("source");
    fireEvent.click(screen.getByRole("button", { name: "Third-party notices" }));
    expect(
      within(screen.getByRole("dialog")).getByText(/SIL OPEN FONT LICENSE Version 1.1/),
    ).toBeTruthy();
    view.unmount();
    render(<AboutPageView embedded {...hooks} info={info} openLink={openLink} />);
    expect(screen.getByRole("dialog", { name: "Third-party notices" })).toBeTruthy();
  });
});
