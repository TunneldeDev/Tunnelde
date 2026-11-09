import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  bindShortcutProvider,
  dispatchShortcuts,
  executeShortcutCandidates,
  scopedShortcutCandidates,
  type ShortcutCandidate,
  type ShortcutRules,
} from "@/lib/keyboard/routing";
import { SHORTCUT_COMMANDS } from "@/lib/keyboard/registry";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
const event = () =>
  new KeyboardEvent("keydown", { key: "j", ctrlKey: true, bubbles: true, cancelable: true });
const candidate = (id: string, run = vi.fn(() => true)): ShortcutCandidate => ({
  command: { id, scope: "workbench", defaults: ["Mod+J"], label: id },
  binding: "Mod+J",
  run,
});
beforeEach(() => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  usePlugins.setState({ items: [] });
});
describe("shortcut routing", () => {
  it("orders all conflicts by descending priority and preserves ties", () => {
    const order: string[] = [];
    const candidates = ["a", "b", "c"].map((id) =>
      candidate(
        id,
        vi.fn(() => {
          order.push(id);
          return true;
        }),
      ),
    );
    executeShortcutCandidates(event(), candidates, {
      b: { "Mod+J": { priority: 10, propagation: "consume" } },
    });
    expect(order).toEqual(["b", "a", "c"]);
  });
  it("keeps conflicting commands by default while suppressing the original key", () => {
    const key = event();
    const a = candidate("a"),
      b = candidate("b");
    expect(executeShortcutCandidates(key, [a, b])).toEqual({ handled: true, consumed: true });
    expect(a.run).toHaveBeenCalledOnce();
    expect(b.run).toHaveBeenCalledOnce();
    expect(key.defaultPrevented).toBe(true);
  });
  it("passes the original key only when every accepted command allows it", () => {
    const key = event();
    const candidates = [candidate("a"), candidate("b")];
    const rules: ShortcutRules = Object.fromEntries(
      candidates.map(({ command }) => [
        command.id,
        { "Mod+J": { priority: 0, propagation: "continue" } },
      ]),
    );
    expect(executeShortcutCandidates(key, candidates, rules).consumed).toBe(false);
    expect(key.defaultPrevented).toBe(false);
    rules.b!["Mod+J"]!.propagation = "consume";
    expect(executeShortcutCandidates(event(), candidates, rules).consumed).toBe(true);
  });
  it("blocks lower priorities only after acceptance; a declined action does not swallow input", () => {
    const high = candidate(
        "high",
        vi.fn(() => false),
      ),
      low = candidate("low");
    const rules: ShortcutRules = { high: { "Mod+J": { priority: 100, propagation: "block" } } };
    executeShortcutCandidates(event(), [low, high], rules);
    expect(low.run).toHaveBeenCalledOnce();
    high.run = vi.fn(() => true);
    vi.mocked(low.run).mockClear();
    executeShortcutCandidates(event(), [low, high], rules);
    expect(low.run).not.toHaveBeenCalled();
    const key = event();
    expect(executeShortcutCandidates(key, [{ ...high, run: () => false }], rules).handled).toBe(
      false,
    );
    expect(key.defaultPrevented).toBe(false);
  });
  it("runs one command once even when Mod and explicit Ctrl bindings overlap", () => {
    const a = candidate("a"),
      b = { ...a, binding: "Ctrl+J" };
    executeShortcutCandidates(event(), [a, b]);
    expect(a.run).toHaveBeenCalledOnce();
  });
  it("collects scoped commands, passes through without duplicate fallback, and unsubscribes", () => {
    useSettings.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        keyboardShortcuts: { "files.copy": ["Mod+J"] },
        shortcutRules: { "files.copy": { "Mod+J": { priority: 100, propagation: "continue" } } },
      },
    });
    const element = document.createElement("div");
    document.body.append(element);
    const run = vi.fn(() => true);
    const unbind = bindShortcutProvider(element, (key) =>
      scopedShortcutCandidates(key, ["files.copy"], run),
    );
    const key = event();
    element.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    dispatchShortcuts(key);
    expect(run).toHaveBeenCalledOnce();
    unbind();
    element.dispatchEvent(event());
    expect(run).toHaveBeenCalledOnce();
    element.remove();
  });
  it("does not route IME, AltGr or dialog input", () => {
    const element = document.createElement("div");
    element.setAttribute("role", "dialog");
    document.body.append(element);
    const run = vi.fn(() => true);
    const unbind = bindShortcutProvider(element, () => [candidate("a", run)]);
    element.dispatchEvent(event());
    element.removeAttribute("role");
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "j", ctrlKey: true, isComposing: true }),
    );
    const altgr = event();
    vi.spyOn(altgr, "getModifierState").mockReturnValue(true);
    element.dispatchEvent(altgr);
    expect(run).not.toHaveBeenCalled();
    unbind();
    element.remove();
  });
  it("allows higher-priority aliases to determine the rule and deduplicates a command", () => {
    const command = SHORTCUT_COMMANDS.find((item) => item.id === "files.copy")!;
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, keyboardShortcuts: { [command.id]: ["Mod+J", "Ctrl+J"] } },
    });
    const run = vi.fn(() => true);
    const key = event();
    executeShortcutCandidates(key, scopedShortcutCandidates(key, [command.id], run), {
      [command.id]: { "Ctrl+J": { priority: 900, propagation: "continue" } },
    });
    expect(key.defaultPrevented).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
