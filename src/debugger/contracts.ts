/** Private development contract; never a stable plugin/local API. */
export interface DebugParameters {
  preset: "normal" | "empty" | "loading" | "error" | "boundary" | "disabled";
  theme: "dark" | "light";
  locale: "zh-CN" | "en-US";
  width: number;
  height: number;
  count: number;
  seed: number;
}
export interface DebugScene {
  id: string;
  surface: string;
  title: string;
}
declare global {
  interface Window {
    __TUNNELDE_DEBUGGER_MOCK__?: boolean;
  }
}
export const mockEnabled = () =>
  import.meta.env.DEV &&
  import.meta.env.VITE_TUNNELDE_DEBUGGER === "1" &&
  typeof window !== "undefined" &&
  window.__TUNNELDE_DEBUGGER_MOCK__ === true;
