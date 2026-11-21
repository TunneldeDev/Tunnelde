import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
it("keeps every main Settings handler in the closed native grammar", () => {
  const file = "src/features/settings/window/mainBinding.tsx";
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let handlers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "handlers" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(source) === "useMemo"
    ) {
      const factory = node.initializer.arguments[0];
      if (!factory || !ts.isArrowFunction(factory)) throw new Error("No handler factory");
      let body = factory.body;
      while (ts.isParenthesizedExpression(body)) body = body.expression;
      if (!ts.isObjectLiteralExpression(body)) throw new Error("No handler map");
      handlers = body.properties.map((property) => property.name!.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const native = readFileSync("src-tauri/src/platform/panel_windows/actions/settings.rs", "utf8");
  const operations = [...native.matchAll(/#\[serde\(rename = "([a-zA-Z_]+)"\)\]/g)].map(
    (match) => match[1],
  );
  expect(handlers.length).toBeGreaterThan(60);
  expect([...operations].sort()).toEqual([...handlers].sort());
  expect(new Set(operations).size).toBe(operations.length);
  expect(native).toContain("deny_unknown_fields");
});
