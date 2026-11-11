import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProfileContent } from "./check-profile-content.mjs";

function fixture() {
  const revision = "pc1:" + "a".repeat(64),
    values = { appearance: { userCss: "x".repeat(1100_000) } };
  const text = JSON.stringify(values),
    pages = [];
  for (let offset = 0; offset < text.length; offset += 65_536) {
    const part = text.slice(offset, offset + 65_536),
      next = offset + part.length;
    pages.push({
      version: 1,
      id: "work",
      revision,
      offset,
      totalBytes: text.length,
      text: part,
      nextOffset: next === text.length ? null : next,
    });
  }
  return {
    catalogue: {
      version: 1,
      revision,
      activeId: null,
      items: [{ id: "work", name: "Work", updatedAt: 1 }],
    },
    pages,
    values,
  };
}
test("profile content CI rejects broken versions, byte offsets, totals, EOF, budgets and altered producer values", () => {
  checkProfileContent(fixture());
  for (const mutate of [
    (f) => f.pages[1].offset++,
    (f) => (f.pages[1].revision += "0"),
    (f) => f.pages[1].totalBytes++,
    (f) => (f.pages[1].nextOffset = null),
    (f) => (f.pages[0].text += "x"),
    (f) => f.pages.pop(),
    (f) => (f.pages[1].id = "other"),
    (f) => (f.catalogue.revision = "p1:old"),
    (f) => (f.values = {}),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => checkProfileContent(f));
  }
});
