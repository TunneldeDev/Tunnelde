import { invoke } from "@tauri-apps/api/core";
import type { ConnectionQuality, Host, HostKeyInfo, SshConnectRequest, SshSession } from "../types";

/** Internal native equality fence; never a plugin grant or persisted credential. */
export interface ConnectionReview {
  hostId: string;
  revision: string;
}

interface Plan {
  review: ConnectionReview;
  jumpHosts: Host[];
}

type Credentials = NonNullable<SshConnectRequest["jumpCredentials"]>;

/** One preparation per mounted prompt, retained even if its initial probe fails. */
export function createReviewedConnection(displayed: Host) {
  let preparation: Promise<Plan> | undefined;
  let current: ConnectionReview | undefined;
  const prepare = () =>
    (preparation ??= invoke<Plan>("connection_review_prepare", { displayed }).then((plan) => {
      current = plan.review;
      return plan;
    }));
  const review = async () => {
    await prepare();
    return current!;
  };
  return {
    key: crypto.randomUUID(),
    prepare,
    review,
    probe: async (credentials: Credentials = {}) =>
      invoke<HostKeyInfo>("connection_review_probe", { review: await review(), credentials }),
    trust: async (
      fingerprint: string,
      credentials: Credentials = {},
      expectedHostId = displayed.id,
    ) => {
      const expected = await review();
      const result = await invoke<{ info: HostKeyInfo; review: ConnectionReview }>(
        "connection_review_trust",
        { review: expected, fingerprint, expectedHostId, credentials },
      );
      if (current !== expected) throw new Error("ssh.connectionChanged");
      current = result.review;
      return result.info;
    },
    connect: async (request: SshConnectRequest) =>
      invoke<SshSession>("connection_review_connect", { review: await review(), request }),
    test: async (id: string, credentials: Credentials) =>
      invoke<ConnectionQuality>("connection_review_test", {
        id,
        review: await review(),
        credentials,
      }),
    installKey: async (password: string | null, credentials: Credentials) =>
      invoke("connection_review_install_key", { review: await review(), password, credentials }),
    credential: async (hostId: string, password: string | null) =>
      invoke<void>("connection_review_credential", { review: await review(), hostId, password }),
  };
}
