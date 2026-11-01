import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import formatterReadme from "../fixtures/plugin-readme.md?raw";
import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";

const mock = vi.hoisted(() => ({ open: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({ api: { openExternal: mock.open } }));
vi.mock("@/store/toasts", () => ({ toast: mock.toast }));
vi.mock("@/lib/api/errors", () => ({ translateError: (error: Error) => error.message }));
beforeEach(() => {
  vi.resetAllMocks();
  mock.open.mockResolvedValue(undefined);
});

describe("plugin README Markdown", () => {
  it("renders the real JSON Formatter README as headings, paragraphs and inline-code commands", () => {
    const { container } = render(<PluginMarkdown source={formatterReadme} />);
    expect(screen.getByRole("heading", { level: 1, name: "JSON Formatter" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Commands" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelector("li code")?.textContent).toBe("pretty");
    expect(container.textContent).not.toContain("## Commands");
    expect(container.textContent).not.toContain("`pretty`");
  });

  it("renders GFM tables, task lists, nested lists, emphasis and fenced code", () => {
    const source = [
      "# Guide",
      "",
      "## Setup",
      "",
      "1. Install **locally**",
      "   - Keep _settings_",
      "",
      "- [x] Ready",
      "- [ ] Optional",
      "",
      "| Feature | Status |",
      "| :--- | ---: |",
      "| Colors | ~~Pending~~ Done |",
      "",
      "```json",
      '{ "name": "<script>" }',
      "  indented line",
      "```",
      "",
      "> A useful note.",
    ].join("\n");
    const { container } = render(<PluginMarkdown source={source} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Feature" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Pending Done" })).toBeTruthy();
    expect(container.querySelector("del")?.textContent).toBe("Pending");
    expect(container.querySelector("ol strong")?.textContent).toBe("locally");
    expect(container.querySelector("ol ul em")?.textContent).toBe("settings");
    expect(
      screen.getAllByRole("checkbox").every((checkbox) => (checkbox as HTMLInputElement).disabled),
    ).toBe(true);
    expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(true);
    expect(container.querySelector("pre code")?.textContent).toBe(
      '{ "name": "<script>" }\n  indented line\n',
    );
    expect(container.querySelector("pre")?.tabIndex).toBe(0);
    expect(screen.getByRole("table").parentElement?.className).toBe("plugin-markdown__table");
    expect(screen.getByRole("table").parentElement?.tabIndex).toBe(0);
    expect(container.querySelector("blockquote")?.textContent).toContain("A useful note.");
    expect(container.querySelector("script")).toBeNull();
  });

  it("keeps copyable external hrefs but opens clicks through the application browser command", () => {
    render(<PluginMarkdown source="[Docs](https://example.org/docs) and <https://nodejs.org/>" />);
    const docs = screen.getByRole("link", { name: "Docs" });
    expect(docs.getAttribute("href")).toBe("https://example.org/docs");
    expect(fireEvent.click(docs)).toBe(false);
    expect(mock.open).toHaveBeenLastCalledWith("https://example.org/docs");
    fireEvent(docs, new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(mock.open).toHaveBeenCalledTimes(2);
    fireEvent(docs, new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true }));
    expect(mock.open).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("link", { name: "https://nodejs.org/" }));
    expect(mock.open).toHaveBeenLastCalledWith("https://nodejs.org/");
  });

  it("scrolls fragment links to a heading inside the current README", () => {
    const { container } = render(
      <>
        <PluginMarkdown source={"## Setup guide\n\nOutside"} />
        <PluginMarkdown source={"[Jump](#setup-guide)\n\n## Setup guide"} />
      </>,
    );
    const readmes = container.querySelectorAll(".plugin-markdown");
    const target = within(readmes[1] as HTMLElement).getByRole("heading", { name: "Setup guide" });
    const scroll = vi.fn();
    Object.defineProperty(target, "scrollIntoView", { value: scroll });
    fireEvent.click(screen.getByRole("link", { name: "Jump" }));
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(mock.open).not.toHaveBeenCalled();
  });

  it("does not inject raw HTML, execute unsafe URL schemes or request remote images", () => {
    const source = [
      "<script>window.__pluginPwned = true</script>",
      "",
      '<img src="https://tracking.example/pixel" onerror="alert(1)">',
      "",
      '<iframe src="https://tracking.example/frame"></iframe>',
      "",
      "[Script](javascript:alert%281%29) [File](file:///C:/secret.txt) [Data](data:text/html,pwned) [Login](https://user:secret@example.org/) [Relative](./README.md)",
      "",
      "![Descriptive image text](https://tracking.example/second-pixel)",
    ].join("\n");
    const { container } = render(<PluginMarkdown source={source} />);
    expect(container.querySelector("script,img,iframe,object,embed")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("Descriptive image text")).toBeTruthy();
    expect(mock.open).not.toHaveBeenCalled();
  });

  it("reports failures from the existing external-link command", async () => {
    mock.open.mockRejectedValueOnce(new Error("Browser unavailable"));
    render(<PluginMarkdown source="[Docs](https://example.org/)" />);
    fireEvent.click(screen.getByRole("link", { name: "Docs" }));
    await vi.waitFor(() => expect(mock.toast).toHaveBeenCalledWith("Browser unavailable", "error"));
  });
});
