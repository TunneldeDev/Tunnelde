import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareTerminalCheckpoints,
  registerTerminalCheckpoint,
  restoreTerminalCheckpoints,
  takeTerminalCheckpoint,
  type TerminalCheckpoint,
} from "@/features/terminal/terminalCheckpoint";

const releases: Array<() => void> = [];
afterEach(() => releases.splice(0).forEach((release) => release()));
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
