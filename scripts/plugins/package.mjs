import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const OFFICIAL_PLUGIN_IDS = ["json-formatter", "timestamp", "uuid"];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function collect(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Plugin package must not contain symbolic links");
    if (entry.isDirectory()) files.push(...(await collect(path, base)));
    else if (entry.isFile())
      files.push({ name: relative(base, path).replaceAll("\\", "/"), bytes: await readFile(path) });
  }
  return files;
}

/** Minimal ZIP writer: fixed DOS epoch, stable names, UTF-8, deflate, no platform extra fields. */
export async function buildPluginArchive(directory) {
  const localParts = [],
    centralParts = [];
  let offset = 0;
  const files = await collect(directory);
  if (!files.some((file) => file.name === "LICENSE"))
    files.push({ name: "LICENSE", bytes: await readFile(join(repository, "LICENSE")) });
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const compressed = deflateRawSync(file.bytes, { level: 9 });
    const checksum = crc32(file.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

export async function packageOfficialPlugins(
  outputDirectory = join(repository, "artifacts", "plugins"),
) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const plugins = [];
  for (const id of OFFICIAL_PLUGIN_IDS) {
    const directory = join(repository, "plugins", id);
    const manifest = JSON.parse(await readFile(join(directory, "tunnelde-plugin.json"), "utf8"));
    if (manifest.id !== id) throw new Error("Plugin id mismatch");
    const bytes = await buildPluginArchive(directory);
    const archive = `${id}-${manifest.version}.zip`;
    await writeFile(join(output, archive), bytes);
    plugins.push({
      id,
      version: manifest.version,
      archive,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      manifest,
    });
  }
  const index = { plugins };
  const catalogue = { plugins: await Promise.all(plugins.map(async (plugin) => ({
    id: plugin.id, name: plugin.manifest.name, version: plugin.version,
    description: plugin.manifest.description,
    author: plugin.manifest.author, runtime: plugin.manifest.runtime,
    apiVersion: plugin.manifest.apiVersion, engines: plugin.manifest.engines,
    readme: await readFile(join(repository, "plugins", plugin.id, "README.md"), "utf8"),
    url: `https://github.com/TunneldeDev/Tunnelde/releases/download/plugins-v1.0.0/${plugin.archive}`,
    sha256: plugin.sha256,
  }))) };
  await writeFile(join(output, "marketplace.json"), JSON.stringify(catalogue, null, 2) + "\n");
  await writeFile(join(output, "index.json"), JSON.stringify(index, null, 2) + "\n");
  await writeFile(
    join(output, "SHA256SUMS"),
    plugins.map((plugin) => `${plugin.sha256}  ${plugin.archive}`).join("\n") + "\n",
  );
  return index;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const index = await packageOfficialPlugins(process.argv[2]);
  for (const plugin of index.plugins) console.log(`${plugin.archive}  ${plugin.sha256}`);
}
