import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const docs = join(root, "docs");
const development = ["en-us/development", "zh-cn/development"];
const forbidden = [
  { label: "delivery tracker", pattern: /delivery[- ]tracker|交付追踪/i },
  { label: "current snapshot section", pattern: /^#{1,6}\s*(?:current snapshot|当前快照)\s*$/im },
  { label: "pull request or CI evidence", pattern: /\b(?:PR|Issue) #\d+|\bCI(?: run)? `?\d{6,}/i },
  { label: "phase delivery section", pattern: /Beta delivery and remaining rollout|Beta 交付与后续开放/i },
];
const failures = [];

async function markdownFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) result.push(path);
  }
  return result;
}

for (const language of development) {
  const directory = join(docs, language);
  for (const path of await markdownFiles(directory)) {
    const text = await readFile(path, "utf8");
    for (const rule of forbidden) {
      if (rule.pattern.test(text)) failures.push(`${relative(root, path)}: ${rule.label}`);
    }
  }
}

const english = (await markdownFiles(join(docs, "en-us"))).map((path) =>
  relative(join(docs, "en-us"), path),
);
const chinese = new Set(
  (await markdownFiles(join(docs, "zh-cn"))).map((path) => relative(join(docs, "zh-cn"), path)),
);
for (const path of english) {
  if (!chinese.has(path)) failures.push(`docs/zh-cn/${path}: missing translation path`);
}
for (const path of chinese) {
  if (!english.includes(path)) failures.push(`docs/en-us/${path}: missing translation path`);
}

if (failures.length) {
  for (const failure of failures) console.error(`[docs] ${failure}`);
  process.exit(1);
}
console.log("[docs] development docs contain no delivery logs and language paths match");
