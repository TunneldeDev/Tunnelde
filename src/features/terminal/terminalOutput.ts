/** Keep UTF-8 state across SSH packets using the browser's native decoder. */
export function createTerminalOutputDecoder() {
  const decoder = new TextDecoder();
  return (chunk: Uint8Array) => decoder.decode(chunk, { stream: true });
}
