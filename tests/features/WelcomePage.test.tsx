import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { WelcomePage } from "@/features/welcome/WelcomePage";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  useHosts.setState({ hosts: [] });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keyboardShortcuts: {} } });
});

describe("welcome keyboard guidance", () => {
  it.each([
    ["MacIntel", "⌘+N New host · ⌘+, Settings"],
    ["Win32", "Ctrl+N New host · Ctrl+, Settings"],
  ])("shows the actual platform modifiers on %s", (platform, expected) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const { container } = render(<WelcomePage />);
    expect(container.querySelector(".welcome__hint")?.textContent).toBe(expected);
  });

  it("reacts to rebinding and unassignment without advertising disabled shortcuts", async () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { container } = render(<WelcomePage />);
    act(() => {
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          keyboardShortcuts: { "host.new": ["Alt+H"], "page.settings": [] },
        },
      });
    });
    expect(container.querySelector(".welcome__hint")?.textContent).toBe("⌥+H New host");
    await act(() => i18n.changeLanguage("zh-CN"));
    expect(container.querySelector(".welcome__hint")?.textContent).toBe("⌥+H 新建主机");
    act(() => {
      useSettings.setState({
        settings: {
          ...DEFAULT_SETTINGS,
          keyboardShortcuts: { "host.new": [], "page.settings": [] },
        },
      });
    });
    expect(container.querySelector(".welcome__hint")).toBeNull();
  });
});
