export interface ProxyProfile {
  id: string;
  name: string;
  protocol: "http" | "socks5";
  host: string;
  port: number;
  username: string;
}
export interface NetworkSettings {
  profiles: ProxyProfile[];
  defaultProxy: string;
  features: Record<string, string>;
}
export interface ConnectionRoute {
  proxy: string;
  jumpHosts: string[];
}
export interface NetworkConnectionQuality {
  attempts: number;
  successful: number;
  samplesMs: (number | null)[];
  medianMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  spreadMs: number | null;
  quality: "fast" | "normal" | "slow" | "unstable" | "unreachable";
  lastError: { code: string; message: string } | null;
}
export const defaultNetwork = (): NetworkSettings => ({
  profiles: [],
  defaultProxy: "",
  features: {},
});
