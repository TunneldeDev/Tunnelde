import { expect, it } from "vitest";
import { reconcileHostFields, validHostField, type HostFieldsSnapshot } from "@/lib/hosts/fields";
it("validates independent scalar metadata and retains only compatible fields during explicit reconciliation", () => {
  const snapshot: HostFieldsSnapshot = {
    schema: {
      version: 2,
      fields: [
        { id: "text", label: "Text", type: "text", maxLength: 2 },
        { id: "flag", label: "Flag", type: "boolean" },
        { id: "cost", label: "Cost", type: "number", minimum: 0 },
        {
          id: "tier",
          label: "Tier",
          type: "select",
          options: [{ value: "prod", label: "Production" }],
        },
      ],
    },
    document: {
      hostId: "a",
      revision: 1,
      schemaDigest: "new",
      schemaVersion: 2,
      storedSchemaVersion: 1,
      schemaChanged: true,
      values: { text: "😀😀", flag: false, cost: 0, tier: "removed", removed: "retained in DB" },
    },
  };
  expect(reconcileHostFields(snapshot)).toEqual({ text: "😀😀", flag: false, cost: 0 });
  expect(snapshot.document.values.removed).toBe("retained in DB");
  for (const value of [null, undefined, "0", NaN, Infinity, -1])
    expect(validHostField(snapshot.schema.fields[2]!, value)).toBe(false);
  expect(validHostField(snapshot.schema.fields[0]!, "\0")).toBe(false);
});
