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
export const defaultNetwork = (): NetworkSettings => ({
  profiles: [],
  defaultProxy: "",
  features: {},
});
