import { reportError } from "@/lib/diagnostics";
import type { TerminalDecoderState } from "./terminalOutput";
import type { TerminalState } from "./terminalState";
import type { CommandCapture } from "@/lib/session/terminalInput";

export interface TerminalCheckpoint {
  sequence: number;
  cols: number;
  rows: number;
  viewportY: number;
  data: string;
  decoder: TerminalDecoderState;
  state: TerminalState;
  input: CommandCapture;
}

export interface TerminalParticipant {
  snapshot?: () => Promise<TerminalCheckpoint>;
  prepare: () => Promise<TerminalCheckpoint>;
  resume: () => Promise<void>;
}

const terminals = new Map<string, TerminalParticipant>();
let restored = new Map<string, TerminalCheckpoint>();

export function registerTerminalCheckpoint(sessionId: string, participant: TerminalParticipant) {
  terminals.set(sessionId, participant);
  return () => {
    if (terminals.get(sessionId) === participant) terminals.delete(sessionId);
  };
}

export function restoreTerminalCheckpoints(checkpoints: Record<string, TerminalCheckpoint>) {
  restored = new Map(Object.entries(checkpoints));
}

export function takeTerminalCheckpoint(sessionId: string) {
  const checkpoint = restored.get(sessionId);
  restored.delete(sessionId);
  return checkpoint;
}

export interface TerminalHandoff {
  readonly checkpoints: Readonly<Record<string, TerminalCheckpoint>>;
  /** Recheck before requesting native ownership transfer, not after commit. */
  isCurrent: () => boolean;
  /** Only after the destination owns the stream. Never reattaches the source. */
  commit: () => Promise<void>;
  /** Idempotent; failed reattachments stay reserved and can be retried. */
  rollback: () => Promise<void>;
}

const reservations = new Map<string, object>();
const recovering = new Set<TerminalHandoff>();
let background: TerminalHandoff | undefined;
let backgroundPreparing = false;

/** A live save shares the handoff reservation, but never freezes input or PTY I/O. */
export async function snapshotTerminalCheckpoint(sessionId: string, signal?: AbortSignal) {
  const participant = terminals.get(sessionId);
  if (!participant?.snapshot || reservations.has(sessionId) || signal?.aborted)
    throw new Error("terminal.checkpointBusy");
  const token = {};
  reservations.set(sessionId, token);
  try {
    const checkpoint = await participant.snapshot();
    if (signal?.aborted || terminals.get(sessionId) !== participant)
      throw new Error("terminal.checkpointBusy");
    return checkpoint;
  } finally {
    if (reservations.get(sessionId) === token) reservations.delete(sessionId);
  }
}

/** Reserve exactly the requested PTYs, not every mounted terminal. This is the
 * document-local half of handoff; it does not grant native stream ownership.
 * Hold the reservation through commit/rollback, including an ignored abort. */
export async function beginTerminalHandoff(
  sessionIds: readonly string[],
  signal?: AbortSignal,
): Promise<TerminalHandoff> {
  const ids = [...new Set(sessionIds)];
  if (signal?.aborted || ids.some((id) => !terminals.has(id) || reservations.has(id)))
    throw new Error("terminal.checkpointBusy");
  const selected = ids.map((id) => [id, terminals.get(id)!] as const);
  const token = {};
  for (const id of ids) reservations.set(id, token);
  const release = () => {
    for (const id of ids) if (reservations.get(id) === token) reservations.delete(id);
  };
  const current = () => selected.every(([id, participant]) => terminals.get(id) === participant);
  let state: "prepared" | "committed" | "rolledBack" = "prepared";
  let rollingBack: Promise<void> | undefined;
  const remaining = new Set(selected.map(([, participant]) => participant));
  let checkpoints: Readonly<Record<string, TerminalCheckpoint>> = {};
  const handoff: TerminalHandoff = {
    get checkpoints() {
      return checkpoints;
    },
    isCurrent: () =>
      state === "prepared" &&
      !rollingBack &&
      !recovering.has(handoff) &&
      !signal?.aborted &&
      current(),
    async commit() {
      if (state === "committed") return;
      if (state !== "prepared" || rollingBack || recovering.has(handoff))
        throw new Error("terminal.checkpointBusy");
      // Native commit is irreversible. The source may already have unmounted
      // or its caller aborted; neither can authorize reattaching the old PTY.
      state = "committed";
      release();
    },
    rollback() {
      if (state !== "prepared") return Promise.resolve();
      if (rollingBack) return rollingBack;
      recovering.add(handoff);
      rollingBack = (async () => {
        const results = await Promise.allSettled(
          [...remaining].map(async (participant) => {
            await participant.resume();
            remaining.delete(participant);
          }),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed) {
          reportError("terminal", "rollbackCheckpoint", failed.reason);
          throw new Error("terminal.checkpointBusy");
        }
        state = "rolledBack";
        recovering.delete(handoff);
        release();
      })().finally(() => {
        rollingBack = undefined;
      });
      return rollingBack;
    },
  };
  const prepared = await Promise.allSettled(
    selected.map(async ([id, terminal]) => [id, await terminal.prepare()] as const),
  );
  const failed = prepared.find((result) => result.status === "rejected");
  if (failed || signal?.aborted || !current()) {
    // Wait for *all* preparations before rollback: a late detach must never
    // occur after we resumed/released its session. Retain failed rollback work.
    // Rollback records its failure and keeps the failed participants for retry.
    await handoff.rollback().catch(() => {});
    throw failed?.status === "rejected" ? failed.reason : new Error("terminal.checkpointBusy");
  }
  checkpoints = Object.freeze(
    Object.fromEntries(
      prepared.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ),
  );
  return handoff;
}

/** Background suspension owns its own batch; a resume notification must not
 * reattach a different terminal currently being moved to another window. */
export async function prepareTerminalCheckpoints(sessionIds: string[]) {
  if (backgroundPreparing || background) throw new Error("terminal.checkpointBusy");
  backgroundPreparing = true;
  try {
    background = await beginTerminalHandoff(sessionIds);
    return background.checkpoints;
  } finally {
    backgroundPreparing = false;
  }
}

export async function resumeTerminalCheckpoints() {
  const pending = new Set(recovering);
  if (background) pending.add(background);
  await Promise.allSettled([...pending].map((handoff) => handoff.rollback()));
  if (background && !recovering.has(background)) background = undefined;
}
