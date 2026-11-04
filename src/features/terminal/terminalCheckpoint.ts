import type { TerminalDecoderState } from "./terminalOutput";
import type { TerminalState } from "./terminalState";

export interface TerminalCheckpoint {
  sequence: number;
  cols: number;
  rows: number;
  viewportY: number;
  data: string;
  decoder: TerminalDecoderState;
  state: TerminalState;
}

export interface TerminalParticipant {
  prepare: () => Promise<TerminalCheckpoint>;
  resume: () => Promise<void>;
}

const terminals = new Map<string, TerminalParticipant>();
let restored: Record<string, TerminalCheckpoint> = {};

export function registerTerminalCheckpoint(sessionId: string, participant: TerminalParticipant) {
  terminals.set(sessionId, participant);
  return () => {
    if (terminals.get(sessionId) === participant) terminals.delete(sessionId);
  };
}

export function restoreTerminalCheckpoints(checkpoints: Record<string, TerminalCheckpoint>) {
  restored = checkpoints;
}

export function takeTerminalCheckpoint(sessionId: string) {
  const checkpoint = restored[sessionId];
  delete restored[sessionId];
  return checkpoint;
}

/** A failed/abandoned checkpoint must reattach every terminal it detached. */
export async function prepareTerminalCheckpoints(sessionIds: string[]) {
  const expected = [...terminals.entries()];
  if (sessionIds.some((id) => !terminals.has(id))) throw new Error("terminal.checkpointBusy");
  const prepared = await Promise.allSettled(
    expected.map(async ([id, terminal]) => [id, await terminal.prepare()] as const),
  );
  const failed = prepared.find((result) => result.status === "rejected");
  if (failed || expected.some(([id, participant]) => terminals.get(id) !== participant)) {
    await Promise.allSettled(expected.map(([, terminal]) => terminal.resume()));
    throw failed?.status === "rejected" ? failed.reason : new Error("terminal.checkpointBusy");
  }
  return Object.fromEntries(
    prepared.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
  );
}

export async function resumeTerminalCheckpoints() {
  await Promise.allSettled([...terminals.values()].map((terminal) => terminal.resume()));
}
