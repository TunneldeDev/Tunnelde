import { beforeEach, expect, it, vi } from "vitest";
import type { Host } from "@/lib/api/types";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { createReviewedConnection } from "@/lib/api/connections/review";

const host = { id: "target", host: "original", port: 22, username: "qa" } as Host;
const review = { hostId: "target", revision: "original" };
const next = { hostId: "target", revision: "explicitly-trusted" };
const known = { hostId: "target", fingerprint: "key", status: "known" };
beforeEach(() => {
  invoke.mockReset().mockImplementation(async (command) => {
    if (command === "connection_review_prepare") return { review, jumpHosts: [] };
    if (command === "connection_review_trust") return { review: next, info: known };
    return known;
  });
});

it("prepares once before network calls and retains that review after an authentication error", async () => {
  const client = createReviewedConnection(host);
  invoke.mockImplementation(async (command) => {
    if (command === "connection_review_prepare") return { review, jumpHosts: [] };
    throw { code: "ssh", message: "ssh.passwordRequired" };
  });
  await expect(client.probe()).rejects.toMatchObject({ message: "ssh.passwordRequired" });
  await expect(client.probe({ jump: { password: "test-only" } })).rejects.toBeDefined();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    "connection_review_prepare",
    "connection_review_probe",
    "connection_review_probe",
  ]);
  expect(invoke.mock.calls[2]).toEqual([
    "connection_review_probe",
    {
      review,
      credentials: { jump: { password: "test-only" } },
    },
  ]);
});

it("advances only an explicit trust response and uses that review for every later operation", async () => {
  const client = createReviewedConnection(host);
  await client.probe();
  expect(await client.trust("key", {}, "target")).toEqual(known);
  await client.connect({ hostId: "target" });
  await client.test("measurement", {});
  await client.installKey(null, {});
  await client.credential("target", "test-only");
  expect(invoke.mock.calls.find(([command]) => command === "connection_review_trust")?.[1]).toEqual(
    {
      review,
      fingerprint: "key",
      expectedHostId: "target",
      credentials: {},
    },
  );
  for (const [command, args] of invoke.mock.calls.slice(3)) {
    expect(command).toMatch(/^connection_review_/);
    expect(args.review).toEqual(next);
  }
  expect(await client.review()).toEqual(next);
});

it("never silently prepares a different route after a failed initial review", async () => {
  invoke.mockRejectedValue({ code: "ssh", message: "ssh.connectionChanged" });
  const client = createReviewedConnection(host);
  await expect(client.probe()).rejects.toMatchObject({ message: "ssh.connectionChanged" });
  await expect(client.connect({ hostId: "target" })).rejects.toBeDefined();
  await expect(client.test("id", {})).rejects.toBeDefined();
  expect(invoke).toHaveBeenCalledExactlyOnceWith("connection_review_prepare", { displayed: host });
});

it("a failed or slower concurrent trust response cannot replace a newer explicit approval", async () => {
  const client = createReviewedConnection(host);
  await client.prepare();
  let finish!: (result: unknown) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const old = client.trust("old-key");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await client.trust("key");
  finish({ review: { ...next, revision: "late" }, info: known });
  await expect(old).rejects.toThrow("ssh.connectionChanged");
  expect(await client.review()).toEqual(next);
});

it("independent prompts never share acquisition keys or mutable trust state", async () => {
  const first = createReviewedConnection(host),
    second = createReviewedConnection(host);
  expect(first.key).not.toEqual(second.key);
  await Promise.all([first.prepare(), second.prepare()]);
  await first.trust("key");
  expect(await second.review()).toEqual(review);
  expect(invoke.mock.calls.filter(([name]) => name === "connection_review_prepare")).toHaveLength(
    2,
  );
});
