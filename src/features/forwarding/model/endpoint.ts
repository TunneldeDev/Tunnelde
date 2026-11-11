export function endpointAddress(host: string, port: number | string): string {
  return `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

export function localConnectionAddress(host: string, port: number | string): string {
  return endpointAddress(host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host, port);
}
