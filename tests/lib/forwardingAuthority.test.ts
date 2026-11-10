import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { createForwardingAuthority } from "@/lib/extensions/forwarding/authority";
import { createProviderLease } from "@/lib/extensions/runtime/providers/lease";

beforeEach(() => invoke.mockReset().mockResolvedValue(undefined));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("coalesces scope acquisition and closes an accepted scope exactly once", async () => {
  const pending = deferred<string>();
  invoke.mockImplementation((command) =>
    command === "forwarding_provider_open" ? pending.promise : Promise.resolve(),
  );
  const lease = createProviderLease();
  const api = createForwardingAuthority("token", "view", "host", vi.fn(), lease.retain);
  const first = api.origin(),
    second = api.origin();
  expect(invoke).toHaveBeenCalledTimes(1);
  pending.resolve("scope");
  expect(await first).toEqual(await second);
  lease.close();
  lease.close();
  expect(invoke.mock.calls.filter(([name]) => name === "forwarding_provider_close")).toHaveLength(
    1,
  );
});

it("late StrictMode acquisition cannot close or replace a newer scope", async () => {
  const old = deferred<string>(),
    next = deferred<string>();
  invoke.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
  const lease = createProviderLease();
  const api = createForwardingAuthority("token", "view", "host", vi.fn(), lease.retain);
  const first = api.origin();
  const failure = expect(first).rejects.toThrow("expired");
  lease.close();
  lease.activate();
  const second = api.origin();
  next.resolve("new");
  expect(await second).toEqual({ token: "token", scope: "new" });
  old.resolve("old");
  await failure;
  expect(await api.origin()).toEqual({ token: "token", scope: "new" });
  expect(invoke).toHaveBeenCalledWith("forwarding_provider_close", {
    origin: { token: "token", scope: "old" },
  });
  lease.close();
  expect(invoke).toHaveBeenCalledWith("forwarding_provider_close", {
    origin: { token: "token", scope: "new" },
  });
});

it("failed acquisition releases its reservation and retries; revocation cleans a late response", async () => {
  const lease = createProviderLease();
  const authorization = vi.fn();
  const api = createForwardingAuthority("token", "view", "host", authorization, lease.retain);
  invoke.mockRejectedValueOnce(Error("quota"));
  await expect(api.origin()).rejects.toThrow("quota");
  const pending = deferred<string>();
  invoke.mockImplementationOnce(() => pending.promise);
  const attempt = api.origin();
  authorization.mockImplementation(() => {
    throw Error("revoked");
  });
  pending.resolve("late");
  await expect(attempt).rejects.toThrow("revoked");
  expect(invoke).toHaveBeenCalledWith("forwarding_provider_close", {
    origin: { token: "token", scope: "late" },
  });
});

it("does not retain a poisoned attempt when lifetime registration fails", async () => {
  const lease = createProviderLease();
  const retain = vi.fn(lease.retain).mockImplementationOnce(() => {
    throw Error("retired");
  });
  const api = createForwardingAuthority("token", "view", "host", vi.fn(), retain);
  await expect(api.origin()).rejects.toThrow("retired");
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce("new-scope");
  expect(await api.origin()).toEqual({ token: "token", scope: "new-scope" });
  lease.close();
  expect(invoke).toHaveBeenCalledWith("forwarding_provider_close", {
    origin: { token: "token", scope: "new-scope" },
  });
});
