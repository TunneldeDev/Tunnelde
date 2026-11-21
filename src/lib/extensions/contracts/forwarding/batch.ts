export interface ForwardStartManyRequest {
  sessionId: string;
  items: { id: string; expectedRevision: string }[];
}

export type ForwardStartManyOutcome =
  | { id: string; status: "started" }
  | { id: string; status: "failed"; error: { code: string; message: string } }
  | { id: string; status: "notStarted" };
