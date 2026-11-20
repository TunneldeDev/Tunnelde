import { expect, it } from "vitest";
import { createPanelViewState } from "@/lib/panels/viewState";
import { PanelStateLossRequired, type PanelStateLoss } from "@/lib/panels/stateLoss";
const loss = (viewId: string): PanelStateLoss => ({ pluginId: "example", viewId });
it("aggregates captureless children without masking a real capture failure", async () => {
  const state = createPanelViewState();
  const one = loss("one"),
    two = loss("two");
  state.registerAsync("one", () => {
    throw new PanelStateLossRequired([one]);
  });
  state.registerAsync("two", () => {
    throw new PanelStateLossRequired([two]);
  });
  const error = await state.captureAsync().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(PanelStateLossRequired);
  expect((error as PanelStateLossRequired).views).toEqual([one, two]);
  state.registerAsync("broken", () => {
    throw new Error("real capture error");
  });
  await expect(state.captureAsync()).rejects.toThrow("real capture error");
  state.dispose();
});
it("never shares consented and unconsented captures or overlaps actual workers", async () => {
  const state = createPanelViewState();
  let finish!: () => void;
  const one = loss("one");
  state.registerAsync(
    "pending",
    () =>
      new Promise((done) => {
        finish = () => done(null);
      }),
  );
  const pending = state.captureAsync();
  await Promise.resolve();
  await expect(
    state.captureAsync(undefined, { consentedStateLoss: new Set([one]) }),
  ).rejects.toThrow("moveInProgress");
  finish();
  await pending;
  state.dispose();
});
