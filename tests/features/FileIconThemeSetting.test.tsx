import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type * as ReactI18next from "react-i18next";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { FileIconThemeSetting } from "@/features/settings/FileIconThemeSetting";
import { PluginFileIconThemes } from "@/features/plugins/PluginFileIconThemes";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useFileIconResolver } from "@/lib/files/icons";
import { plugin as pluginFixture } from "../fixtures/plugins";

vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
const theme = {
  id: "common",
  name: "Common files",
  icons: { typescript: { symbol: "code" as const, color: "#3178c6", label: "TS" } },
  extensions: { ts: "typescript" },
  fileNames: {},
};
const plugin: PluginInfo = {
  ...pluginFixture,
  id: "common-icons",
  name: "Common Icons",
  fileIconThemes: [theme],
};
const update = vi.fn();
beforeEach(() => {
  update.mockReset().mockResolvedValue(true);
  useSettings.setState({ settings: createDefaultSettings(), update });
  usePlugins.setState({ items: [plugin] });
});

it("offers installed themes and preserves an unavailable selection until the user changes it", async () => {
  render(<FileIconThemeSetting value="removed:theme" descriptionId="help" onChange={update} />);
  const select = screen.getByRole("button", { name: "settings.fileIconTheme" });
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole("option", { name: "Common files · Common Icons" }));
  expect(update).toHaveBeenCalledWith("common-icons:common");
});

it("applies a plugin theme from its detail page with one click and shows the active choice", async () => {
  useSettings.setState({ settings: { ...createDefaultSettings(), fileIconTheme: "none" } });
  render(<PluginFileIconThemes plugin={plugin} disabled={false} />);
  fireEvent.click(screen.getByRole("button", { name: "plugins.applyTheme" }));
  expect(update).toHaveBeenCalledWith({ fileIconTheme: "common-icons:common" });
  act(() =>
    useSettings.setState({
      settings: { ...createDefaultSettings(), fileIconTheme: "common-icons:common" },
    }),
  );
  expect(
    screen.getByRole("button", { name: "plugins.themeApplied" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("updates file views after installation, theme changes and removal without starting a runtime", async () => {
  function Example() {
    const resolve = useFileIconResolver();
    return <FileTypeIcon icon={resolve("example.ts")} />;
  }
  const { container } = render(<Example />);
  expect(container.textContent).toBe("TS");
  act(() =>
    useSettings.setState({ settings: { ...createDefaultSettings(), fileIconTheme: "none" } }),
  );
  await waitFor(() => expect(container.textContent).toBe(""));
  act(() => useSettings.setState({ settings: createDefaultSettings() }));
  expect(container.textContent).toBe("TS");
  act(() => usePlugins.setState({ items: [] }));
  expect(container.textContent).toBe("");
});
