import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginTerminalHandoff,
  resumeTerminalCheckpoints,
  prepareTerminalCheckpoints,
  registerTerminalCheckpoint,
  restoreTerminalCheckpoints,
  takeTerminalCheckpoint,
  type TerminalCheckpoint,
} from "@/features/terminal/terminalCheckpoint";

const releases: Array<() => void> = [];
afterEach(async () => {
  await resumeTerminalCheckpoints();
  releases.splice(0).forEach((release) => release());
});
const checkpoint = { sequence: 3, data: "screen" } as TerminalCheckpoint;

describe("terminal checkpoint coordination", () => {
  it("waits for all participants, restores once and refuses an unmounted required terminal", async () => {
    let resolve!: (value: TerminalCheckpoint) => void;
    releases.push(
      registerTerminalCheckpoint("one", {
        prepare: () =>
          new Promise((done) => {
            resolve = done;
          }),
        resume: vi.fn(),
      }),
    );
    const pending = prepareTerminalCheckpoints(["one"]);
    resolve(checkpoint);
    const prepared = await pending;
    restoreTerminalCheckpoints(prepared);
    expect(takeTerminalCheckpoint("one")).toEqual(checkpoint);
    expect(takeTerminalCheckpoint("one")).toBeUndefined();
    await expect(prepareTerminalCheckpoints(["missing"])).rejects.toThrow(
      "terminal.checkpointBusy",
    );
  });

  it("reattaches every participant if one snapshot fails after detaching", async () => {
    const resumeOne = vi.fn().mockResolvedValue(undefined);
    const resumeTwo = vi.fn().mockResolvedValue(undefined);
    releases.push(
      registerTerminalCheckpoint("one", { prepare: async () => checkpoint, resume: resumeOne }),
    );
    releases.push(
      registerTerminalCheckpoint("two", {
        prepare: async () => {
          throw new Error("snapshot too large");
        },
        resume: resumeTwo,
      }),
    );
    await expect(prepareTerminalCheckpoints(["one", "two"])).rejects.toThrow("snapshot too large");
    expect(resumeOne).toHaveBeenCalledOnce();
    expect(resumeTwo).toHaveBeenCalledOnce();
  });

  it("does not publish a snapshot if the terminal was replaced during preparation", async () => {
    let finish!: (value: TerminalCheckpoint) => void;
    const resume = vi.fn().mockResolvedValue(undefined);
    releases.push(
      registerTerminalCheckpoint("one", {
        prepare: () =>
          new Promise((done) => {
            finish = done;
          }),
        resume,
      }),
    );
    const pending = prepareTerminalCheckpoints(["one"]);
    releases.push(
      registerTerminalCheckpoint("one", { prepare: async () => checkpoint, resume: vi.fn() }),
    );
    finish(checkpoint);
    await expect(pending).rejects.toThrow("terminal.checkpointBusy");
    expect(resume).toHaveBeenCalledOnce();
  });
});

describe("single-terminal handoff reservations", () => {
  function participant(id: string) {
    const terminal = {
      prepare: vi.fn().mockResolvedValue(checkpoint),
      resume: vi.fn().mockResolvedValue(undefined),
    };
    releases.push(registerTerminalCheckpoint(id, terminal));
    return terminal;
  }
  it("only detaches the selected terminal, once for duplicate IDs", async () => {
    const one = participant("one"),
      two = participant("two");
    const handoff = await beginTerminalHandoff(["one", "one"]);
    expect(Object.keys(handoff.checkpoints)).toEqual(["one"]);
    expect(one.prepare).toHaveBeenCalledOnce();
    expect(two.prepare).not.toHaveBeenCalled();
    await resumeTerminalCheckpoints();
    expect(one.resume).not.toHaveBeenCalled();
    await handoff.rollback();
    await handoff.rollback();
    expect(one.resume).toHaveBeenCalledOnce();
    expect(two.resume).not.toHaveBeenCalled();
  });
  it("reserves atomically, and refuses overlap without detaching another terminal", async () => {
    participant("one");
    const two = participant("two");
    const first = await beginTerminalHandoff(["one"]);
    await expect(beginTerminalHandoff(["two", "one"])).rejects.toThrow("terminal.checkpointBusy");
    expect(two.prepare).not.toHaveBeenCalled();
    const parallel = await beginTerminalHandoff(["two"]);
    await parallel.rollback();
    await first.rollback();
    const retry = await beginTerminalHandoff(["one"]);
    await retry.rollback();
  });
  it("does not let a background resume steal a handoff's stream", async () => {
    const one = participant("one"),
      two = participant("two");
    const handoff = await beginTerminalHandoff(["one"]);
    await prepareTerminalCheckpoints(["two"]);
    await resumeTerminalCheckpoints();
    expect(one.resume).not.toHaveBeenCalled();
    expect(two.resume).toHaveBeenCalledOnce();
    await handoff.rollback();
  });
  it("does not resume the source after native commit, even if it has unmounted", async () => {
    const one = participant("one");
    const handoff = await beginTerminalHandoff(["one"]);
    expect(handoff.isCurrent()).toBe(true);
    releases.pop()!();
    expect(handoff.isCurrent()).toBe(false);
    await handoff.commit();
    await handoff.commit();
    await handoff.rollback();
    await resumeTerminalCheckpoints();
    expect(one.resume).not.toHaveBeenCalled();
  });
  it("rolls back the captured participant, never a replacement", async () => {
    const one = participant("one");
    const handoff = await beginTerminalHandoff(["one"]);
    const replacement = participant("one");
    expect(handoff.isCurrent()).toBe(false);
    await handoff.rollback();
    expect(one.resume).toHaveBeenCalledOnce();
    expect(replacement.resume).not.toHaveBeenCalled();
    await expect(handoff.commit()).rejects.toThrow("terminal.checkpointBusy");
  });
  it("waits for late detach before rollback on cancellation, retaining the reservation", async () => {
    const one = participant("one");
    let finish!: (value: TerminalCheckpoint) => void;
    one.prepare.mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const controller = new AbortController();
    const pending = beginTerminalHandoff(["one"], controller.signal);
    controller.abort();
    await expect(beginTerminalHandoff(["one"])).rejects.toThrow("terminal.checkpointBusy");
    expect(one.resume).not.toHaveBeenCalled();
    finish(checkpoint);
    await expect(pending).rejects.toThrow("terminal.checkpointBusy");
    expect(one.resume).toHaveBeenCalledOnce();
    const retry = await beginTerminalHandoff(["one"]);
    await retry.rollback();
  });
  it("keeps failed reattachments reserved and retries only failures", async () => {
    const one = participant("one"),
      two = participant("two");
    two.resume.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const handoff = await beginTerminalHandoff(["one", "two"]);
    await expect(handoff.rollback()).rejects.toThrow("terminal.checkpointBusy");
    expect(handoff.isCurrent()).toBe(false);
    await expect(beginTerminalHandoff(["one"])).rejects.toThrow("terminal.checkpointBusy");
    await resumeTerminalCheckpoints();
    expect(one.resume).toHaveBeenCalledOnce();
    expect(two.resume).toHaveBeenCalledTimes(2);
    const retry = await beginTerminalHandoff(["one", "two"]);
    await retry.rollback();
  });
  it("recovers a failed prepare even if the first rollback also fails", async () => {
    const one = participant("one");
    one.prepare.mockRejectedValueOnce(new Error("serialize failed"));
    one.resume.mockRejectedValueOnce(new Error("attach failed"));
    await expect(beginTerminalHandoff(["one"])).rejects.toThrow("serialize failed");
    await expect(beginTerminalHandoff(["one"])).rejects.toThrow("terminal.checkpointBusy");
    await resumeTerminalCheckpoints();
    const retry = await beginTerminalHandoff(["one"]);
    await retry.rollback();
  });
  it("refuses a pre-aborted request without touching the PTY", async () => {
    const one = participant("one");
    await expect(beginTerminalHandoff(["one"], AbortSignal.abort())).rejects.toThrow(
      "terminal.checkpointBusy",
    );
    expect(one.prepare).not.toHaveBeenCalled();
  });
});
