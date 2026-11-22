import { expect, it } from "vitest";
import { panelIconKind } from "@/lib/panels/panelIcons";

it("keeps detached settings and every native page identity on a stable icon slot", () => {
  expect(panelIconKind("settings-view:0a0a")).toBe("settings");
  expect(panelIconKind("editor-view:0a0a")).toBe("editor");
  expect(panelIconKind("host-view:0a0a")).toBe("host");
  expect(panelIconKind("files:0a0a")).toBe("files");
  expect(panelIconKind("terminal:0a0a")).toBe("terminal");
  expect(panelIconKind("plugin:example:main")).toBe("plugin");
  expect(panelIconKind("unknown")).toBe("other");
});
