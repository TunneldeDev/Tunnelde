import { afterEach, expect, it, vi } from "vitest";
import { domainEvents } from "@/lib/events/domain";

let lifetime = new AbortController();
afterEach(() => {
  lifetime.abort();
  lifetime = new AbortController();
});

it("attaches local history notifications synchronously and accepts integration CustomEvents", async () => {
  const history = vi.fn();
  const registration = domainEvents.onHistory(history, lifetime.signal);
  domainEvents.historyChanged("one");
  window.dispatchEvent(new Event("tunnelde:history-changed"));
  await registration;
  expect(history.mock.calls).toEqual([[{ hostId: "one" }], [{}]]);
});

it("shares the browser listener and preserves independent panel lifetimes", async () => {
  const add = vi.spyOn(window, "addEventListener"),
    remove = vi.spyOn(window, "removeEventListener");
  const a = vi.fn(),
    b = vi.fn();
  const first = await domainEvents.onHistory(a, lifetime.signal);
  await domainEvents.onHistory(b, lifetime.signal);
  expect(add.mock.calls.filter(([name]) => name === "tunnelde:history-changed")).toHaveLength(1);
  first();
  domainEvents.historyChanged("two");
  expect(a).not.toHaveBeenCalled();
  expect(b).toHaveBeenCalledWith({ hostId: "two" });
  lifetime.abort();
  expect(remove.mock.calls.filter(([name]) => name === "tunnelde:history-changed")).toHaveLength(1);
  add.mockRestore();
  remove.mockRestore();
});

it("ignores malformed file invalidations and forwards valid local and remote sources", async () => {
  const files = vi.fn();
  await domainEvents.onFiles(files, lifetime.signal);
  window.dispatchEvent(new Event("tunnelde:files-changed"));
  window.dispatchEvent(
    new CustomEvent("tunnelde:files-changed", {
      detail: { source: { kind: "remote" }, origin: "invalid" },
    }),
  );
  domainEvents.filesChanged({ source: { kind: "local" }, origin: "one" });
  domainEvents.filesChanged({ source: { kind: "remote", sessionId: "ssh-1" }, origin: "two" });
  expect(files.mock.calls).toEqual([
    [{ source: { kind: "local" }, origin: "one" }],
    [{ source: { kind: "remote", sessionId: "ssh-1" }, origin: "two" }],
  ]);
});
