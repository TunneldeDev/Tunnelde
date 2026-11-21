import { expect, it } from "vitest";
import {
  editorDraft,
  forwardDraft,
  forwardingSelection,
  groupEditor,
} from "@/features/forwarding/model/viewState";
import { initialForwardRule } from "@/features/forwarding/model/payload";

it("restores partial port text but never a different host, rule or revision", () => {
  const rule = { ...initialForwardRule("host"), id: "rule", revision: "one" };
  const draft = { ...rule, bindPort: "", targetPort: "0" };
  expect(editorDraft(draft, rule)).toBe(true);
  expect(editorDraft({ ...draft, hostId: "other" }, rule)).toBe(false);
  expect(editorDraft({ ...draft, id: "other" }, rule)).toBe(false);
  expect(editorDraft({ ...draft, revision: "two" }, rule)).toBe(false);
  expect(editorDraft({ ...draft, mode: "dynamic" }, rule)).toBe(false);
  expect(editorDraft({ ...draft, automation: { autoStart: true } }, rule)).toBe(false);
  expect(forwardDraft(rule, "host")).toBe(true);
  expect(forwardDraft({ ...rule, bindPort: "" }, "host")).toBe(false);
  expect(forwardDraft({ ...rule, targetPort: NaN }, "host")).toBe(false);
});

it("requires explicit host identity even for a new group with no saved ID", () => {
  expect(groupEditor(null, "host")).toBe(true);
  expect(groupEditor({}, "host")).toBe(false);
  expect(groupEditor({ hostId: "other" }, "host")).toBe(false);
  expect(groupEditor({ hostId: "host" }, "host")).toBe(true);
  expect(
    groupEditor(
      { hostId: "host", group: { id: "group", hostId: "other", name: "Name", revision: "one" } },
      "host",
    ),
  ).toBe(false);
  expect(forwardingSelection({ hostId: "host", targetRevision: -1 })).toBe(false);
  expect(forwardingSelection({ hostId: null, targetRevision: 1.5 })).toBe(false);
  expect(forwardingSelection({ hostId: null, targetRevision: 0 })).toBe(true);
});
