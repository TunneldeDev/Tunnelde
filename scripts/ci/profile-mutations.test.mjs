import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProfileMutations } from "./check-profile-mutations.mjs";

function fixture() {
  const revision = "pc1:" + "a".repeat(64);
  const values = { appearance: { userCss: "x".repeat(1100_000) } };
  const text = JSON.stringify(values),
    draftId = "draft-one",
    totalBytes = text.length;
  const upload = [
    {
      method: "profiles.drafts.prepare",
      request: { revision, totalBytes },
      result: { version: 1, draftId, totalBytes, offset: 0 },
    },
  ];
  for (let offset = 0; offset < text.length; offset += 32768) {
    const part = text.slice(offset, offset + 32768);
    upload.push({
      method: "profiles.drafts.append",
      request: { draftId, offset, text: part },
      result: { version: 1, draftId, totalBytes, offset: offset + part.length },
    });
  }
  const saveResult = { version: 1, id: "work", revision: "pc1:" + "b".repeat(64) };
  const renameResult = { version: 1, id: "work", revision: "pc1:" + "c".repeat(64) };
  return {
    revision,
    values,
    upload,
    saveRequest: { revision, draftId, name: "Work" },
    saveResult,
    renameRequest: { id: "work", revision: saveResult.revision, name: "Renamed" },
    renameResult,
    deleteRequest: { id: "work", revision: renameResult.revision },
    deleteResult: { version: 1, id: "work", revision: "pc1:" + "d".repeat(64) },
  };
}

test("profile mutation CI rejects invalid upload, result identities, stale revisions and private fields", () => {
  checkProfileMutations(fixture());
  for (const mutate of [
    (f) => f.upload[1].request.offset++,
    (f) => f.upload[1].result.offset++,
    (f) => f.upload[1].result.totalBytes++,
    (f) => (f.upload[1].result.draftId = "foreign"),
    (f) => (f.upload[0].request.revision = "p1:old"),
    (f) => (f.upload[1].request.text += "x"),
    (f) => f.upload.pop(),
    (f) => (f.saveRequest.draftId = "foreign"),
    (f) => (f.saveResult.private = "never-public"),
    (f) => (f.renameRequest.id = "foreign"),
    (f) => (f.renameResult.id = "foreign"),
    (f) => (f.deleteResult.revision = f.deleteRequest.revision),
    (f) => (f.renameRequest.name = "invalid\n"),
    (f) => (f.values = {}),
  ]) {
    const changed = fixture();
    mutate(changed);
    assert.throws(() => checkProfileMutations(changed));
  }
});
