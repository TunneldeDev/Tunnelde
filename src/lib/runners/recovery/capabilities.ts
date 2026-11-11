/** Native, transient helper discovery; capabilities are never cached authority. */
export interface RecoveryCapabilityObservation {
  token: string;
  checkedAt: number;
  result:
    | {
        status: "available";
        envelope: {
          schemaVersion: number;
          helper: string;
          helperVersion: string;
          runnerProtocols: number[];
          features: string[];
        };
      }
    | {
        status: "unavailable";
        reason:
          | "transport"
          | "timeout"
          | "outputTooLarge"
          | "missingExitStatus"
          | "nonzeroExit"
          | "invalidResponse"
          | "unsupportedSchema";
        exitCode?: number;
      };
}
