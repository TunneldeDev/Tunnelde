import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve("src/lib/extensions");
const entry = resolve(root, "uiSdkContract.ts");
const historical = resolve("tests/fixtures/plugin-compat/ui-sdk-0.1.0/contract.d.ts");
const files = readdirSync(resolve(root, "contracts"), { recursive: true })
  .filter((name): name is string => typeof name === "string" && name.endsWith(".ts"))
  .map((name) => resolve(root, "contracts", name));

describe("public UI contract boundaries", () => {
  const program = ts.createProgram([entry, historical, ...files], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  });
  const checker = program.getTypeChecker();
  const exportsOf = (path: string) => {
    const source = program.getSourceFile(path)!;
    return new Map(
      checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).map((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        return [symbol.name, checker.getDeclaredTypeOfSymbol(target)] as const;
      }),
    );
  };

  it("resolves every public domain and legacy import without declaration errors", () => {
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(errors).toEqual([]);
  });

  it("preserves historical exports with only the documented experimental target widening", () => {
    expect(
      createHash("sha256")
        .update(readFileSync(historical, "utf8").replaceAll("\r\n", "\n"))
        .digest("hex"),
    ).toBe("5c3d4dd56cff9723724b6c43557a84459c8274783451c81c6e633f0e7a5e5339");
    const before = exportsOf(historical),
      after = exportsOf(entry);
    expect([...after.keys()].filter((name) => !before.has(name)).sort()).toEqual([
      "ConfigurationBackup",
      "ConfigurationBackupRequest",
      "ConfigurationDocument",
      "ConfigurationExpected",
      "ConfigurationField",
      "ConfigurationMigration",
      "ConfigurationSchema",
      "ConfigurationSnapshot",
      "ConfigurationUpdate",
      "ConfigurationValueSchema",
      "FrontendBackgroundTaskContext",
      "FrontendBackgroundTaskEntry",
      "FrontendBackgroundTaskOptions",
      "FrontendBackgroundTaskRunner",
      "FrontendBackgroundTasks",
      "FrontendBackgroundTasksSnapshot",
      "FrontendForwarding",
      "FrontendForwardingEntry",
      "FrontendForwardingSnapshot",
      "FrontendMonitor",
      "FrontendMonitorReading",
      "FrontendMonitorSample",
      "FrontendMonitorSnapshot",
      "FrontendPreferenceField",
      "FrontendPreferences",
      "FrontendPreferencesSnapshot",
      "FrontendProcessColumn",
      "FrontendProcessEntry",
      "FrontendProcessSort",
      "FrontendProcesses",
      "FrontendProcessesSnapshot",
      "FrontendQuickAccess",
      "FrontendQuickAccessEntry",
      "FrontendQuickAccessSnapshot",
      "FrontendTaskProgress",
      "PreferenceAppearance",
      "PreferenceChanges",
      "PreferenceEditor",
      "PreferenceFiles",
      "PreferenceGeneral",
      "PreferenceMonitoring",
      "PreferenceNetwork",
      "PreferenceSchema",
      "PreferenceSchemaNode",
      "PreferenceShortcuts",
      "PreferenceSnapshot",
      "PreferenceTerminal",
      "PreferenceTransfers",
      "PreferenceUpdate",
      "PreferenceUpdates",
      "PreferenceValues",
      "PreferenceWorkspace",
      "RuntimeResource",
      "RuntimeResourceKind",
      "RuntimeResourceRelease",
      "RuntimeResourceReleased",
      "RuntimeResourceState",
      "RuntimeResourcesQuery",
      "RuntimeResourcesSnapshot",
      "UiChildResourceOptions",
    ]);
    const widened: string[] = [];
    for (const [name, original] of before) {
      const current = after.get(name)!;
      expect(checker.isTypeAssignableTo(original, current), `${name}: old to new`).toBe(true);
      if (!checker.isTypeAssignableTo(current, original)) widened.push(name);
    }
    expect(widened.sort()).toEqual(["FrontendProviderContribution", "FrontendProviderTarget"]);
    const domains = new Map(files.flatMap((path) => [...exportsOf(path)]));
    expect([...domains.keys()].sort()).toEqual([...after.keys()].sort());
  });

  it("keeps the compatibility entry export-only and domains free of runtime or private imports", () => {
    for (const path of [entry, ...files]) {
      const source = program.getSourceFile(path)!;
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
          expect(statement.importClause?.isTypeOnly, path).toBe(true);
          expect(path).not.toBe(entry);
          const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
          if (specifier !== "react") {
            const target = resolve(path, "..", specifier.replace(/\.js$/, ".ts"));
            expect(files, `${path}: ${specifier}`).toContain(target);
          }
        } else if (ts.isExportDeclaration(statement)) {
          expect(statement.isTypeOnly, path).toBe(true);
        } else {
          expect(path).not.toBe(entry);
          expect(
            ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
            path,
          ).toBe(true);
        }
      }
    }
    expect(readFileSync(entry, "utf8")).not.toContain("export interface");
  });
});
