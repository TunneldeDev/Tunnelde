import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { usePanelViewController } from "@/lib/panels/viewState";

interface MediaState {
  time: number;
  volume: number;
  muted: boolean;
  rate: number;
}
const valid = (value: unknown): value is MediaState => {
  if (!value || typeof value !== "object") return false;
  const state = value as MediaState;
  return (
    Number.isFinite(state.time) &&
    state.time >= 0 &&
    state.time <= 1e12 &&
    Number.isFinite(state.volume) &&
    state.volume >= 0 &&
    state.volume <= 1 &&
    typeof state.muted === "boolean" &&
    Number.isFinite(state.rate) &&
    state.rate >= 0.25 &&
    state.rate <= 4
  );
};
/** Capture playback position/settings, never a URL or native ticket. Restoring
 * is deliberately paused: staging a WebView may not start a second player. */
export function usePreviewMediaState(elementRef: RefObject<HTMLMediaElement | null>) {
  const controller = usePanelViewController();
  const [incoming] = useState(() => controller?.read("media", valid));
  const applied = useRef(false);
  useLayoutEffect(
    () =>
      controller?.register("media", () => {
        const player = elementRef.current;
        // Before metadata arrives, retain the original state rather than replacing
        // it with a zero-time spinner snapshot during a close/checkpoint.
        if (!player || !applied.current)
          return incoming ?? { time: 0, volume: 1, muted: false, rate: 1 };
        const state = {
          time: player.currentTime,
          volume: player.volume,
          muted: player.muted,
          rate: player.playbackRate,
        };
        if (!valid(state)) throw new Error("panel.viewState.invalid");
        return state;
      }),
    [controller, incoming, elementRef],
  );
  return () => {
    const player = elementRef.current;
    if (!player || applied.current) return;
    if (incoming) {
      player.volume = incoming.volume;
      player.muted = incoming.muted;
      player.playbackRate = incoming.rate;
      player.currentTime = Number.isFinite(player.duration)
        ? Math.min(incoming.time, Math.max(0, player.duration))
        : incoming.time;
    }
    applied.current = true;
  };
}
