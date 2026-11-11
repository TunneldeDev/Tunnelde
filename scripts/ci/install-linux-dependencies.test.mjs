import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveSource, installDependencies } from "./linux/apt.mjs";

const list = "/etc/apt/sources.list",
  deb822 = "/etc/apt/sources.list.d/ubuntu.sources";
function fixture(fail = () => false) {
  const original = "deb https://azure.archive.ubuntu.com/ubuntu/ jammy main\n",
    files = new Map([[list, original]]),
    calls = [],
    writes = [];
  return {
    files,
    calls,
    writes,
    original,
    options: {
      read: async (path) => {
        if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(path);
      },
      write: async (path, value) => {
        writes.push([path, value]);
        files.set(path, value);
      },
      run: async (args, timeout) => {
        calls.push({ args, timeout, source: files.get(list) });
        if (fail(calls.length, args)) throw new Error("temporary DNS failure");
      },
      log: () => {},
    },
  };
}
test("Ubuntu mirror normalization supports list/deb822 and preserves other repositories", () => {
  assert.equal(
    archiveSource("URIs: mirror+file:/etc/apt/apt-mirrors.txt\n"),
    "URIs: https://archive.ubuntu.com/ubuntu/\n",
  );
  assert.equal(
    archiveSource("URIs: mirror+file:///etc/apt/apt-mirrors.txt\n"),
    "URIs: https://archive.ubuntu.com/ubuntu/\n",
  );
  assert.equal(
    archiveSource("deb http://us.archive.ubuntu.com/ubuntu jammy main"),
    "deb https://archive.ubuntu.com/ubuntu/ jammy main",
  );
  const thirdParty = "deb https://packages.microsoft.com/ubuntu/22.04/prod jammy main";
  assert.equal(archiveSource(thirdParty), thirdParty);
});
test("successful primary installation uses strict index errors and bounded deadlines, then restores sources", async () => {
  const f = fixture();
  await installDependencies(f.options);
  assert.equal(f.calls.length, 2);
  assert(f.calls[0].args.includes("APT::Update::Error-Mode=any"));
  assert(f.calls[0].source.includes("https://archive.ubuntu.com/"));
  assert.equal(f.calls[0].timeout, 90000);
  assert.equal(f.calls[1].timeout, 150000);
  assert(f.calls[1].args.includes("libwebkit2gtk-4.1-dev"));
  assert.equal(f.files.get(list), f.original);
});
test("DNS/index failure falls back to an independent mirror without installing against stale indexes", async () => {
  const f = fixture((n) => n === 1);
  await installDependencies(f.options);
  assert.equal(f.calls.length, 3);
  assert(f.calls[1].args.includes("update"));
  assert(f.calls[1].source.includes("https://mirrors.edge.kernel.org/ubuntu/"));
  assert(f.calls[2].args.includes("install"));
  assert.equal(f.files.get(list), f.original);
});
test("download/install failure retries both update and install with independent mirrors", async () => {
  const f = fixture((n) => n === 2);
  await installDependencies(f.options);
  assert.equal(f.calls.length, 4);
  assert(f.calls[2].source.includes("https://mirrors.edge.kernel.org/ubuntu/"));
  assert(f.calls[2].args.includes("update"));
});
test("two unreachable mirrors fall back to the runner's original configuration and preserve signature settings", async () => {
  const f = fixture((n) => n < 3);
  const signed =
    "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n";
  f.files.set(deb822, signed);
  await installDependencies(f.options);
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[2].source, f.original);
  assert(f.calls[2].args.includes("APT::Update::Error-Mode=any"));
  assert(f.calls[3].args.includes("install"));
  for (const [path, value] of f.writes.filter(([path]) => path === deb822)) {
    assert.equal(path, deb822);
    assert(value.includes("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg"));
  }
  assert.equal(f.files.get(deb822), signed);
});
test("all failures restore list and deb822 sources and report failure", async () => {
  const f = fixture(() => true);
  const text = "URIs: mirror+file:///etc/apt/apt-mirrors.txt\n";
  f.files.set(deb822, text);
  await assert.rejects(installDependencies(f.options), /all source strategies/);
  assert.equal(f.calls.length, 3);
  assert.equal(f.files.get(list), f.original);
  assert.equal(f.files.get(deb822), text);
});
test("missing and unreadable configurations fail before package execution", async () => {
  const f = fixture();
  f.files.clear();
  await assert.rejects(installDependencies(f.options), /No Ubuntu/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    installDependencies({
      ...f.options,
      read: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    }),
    /denied/,
  );
});
