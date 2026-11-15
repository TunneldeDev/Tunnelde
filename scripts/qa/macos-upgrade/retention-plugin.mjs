// Installed through the public GUI only in a pristine disposable hosted account.
// All application access goes through the approved public plugin SDK.
const key = "ota-preserved";
const command = "echo ota-preserved-history";
const hostName = "OTA preserved host 主机";

async function digest(value) {
  const bytes = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new globalThis.TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyData(call, expectedSecret) {
  const saved = await call("storage.get", { key });
  if (
    saved?.marker !== "OTA 插件数据保留" ||
    saved?.nested?.count !== 42 ||
    typeof saved.hostId !== "string"
  )
    throw new Error("Stored fixture missing or changed");
  const hosts = (await call("hosts.snapshot", {})).hosts;
  if (!hosts.some((host) => host.id === saved.hostId && host.name === hostName))
    throw new Error("Saved host missing");
  const history = await call("history.list", { hostId: saved.hostId, limit: 20 });
  if (!history.some((entry) => entry.command === command)) throw new Error("History missing");
  const secret = await call("secrets.get", { key });
  if (
    typeof secret !== "string" ||
    !/^[a-f0-9]{64}$/.test(secret) ||
    (expectedSecret !== undefined && secret !== expectedSecret)
  )
    throw new Error("Secret missing or changed");
  // Only this approved app reads its own secret. Export a hash through its view,
  // never a plaintext copy, so the external runner can compare source and target.
  return {
    hostRetained: true,
    nonemptyHistory: true,
    storageRetained: true,
    secretSha256: await digest(secret),
  };
}

export async function seedData(call) {
  if ((await call("storage.get", { key })) !== null) throw new Error("Fixture already exists");
  const hosts = (await call("hosts.snapshot", {})).hosts.filter((host) => host.name === hostName);
  if (
    hosts.length !== 1 ||
    hosts[0].host !== "127.0.0.1" ||
    hosts[0].port !== 2209 ||
    hosts[0].username !== "qa"
  )
    throw new Error("Unexpected synthetic host");
  const secret = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  await call("history.record", { hostId: hosts[0].id, command });
  await call("secrets.set", { key, value: secret });
  await call("storage.set", {
    key,
    value: {
      marker: "OTA 插件数据保留",
      nested: { count: 42 },
      hostId: hosts[0].id,
    },
  });
  return verifyData(call, secret);
}

export function activate(context) {
  const React = context.sdk.react;
  const { Button } = context.sdk.components;
  const h = React.createElement;
  const call = (method, params) => context.api.call(method, params);
  function Retention() {
    const [status, setStatus] = React.useState("OTA retention ready");
    const [busy, setBusy] = React.useState(false);
    const [summary, setSummary] = React.useState(null);
    const perform = async (seed) => {
      if (busy) return;
      setBusy(true);
      setStatus("OTA retention working");
      try {
        setSummary(await (seed ? seedData(call) : verifyData(call)));
        setStatus(seed ? "OTA retention seeded" : "OTA retention verified");
      } catch {
        // Never render or log a credential, RPC input or arbitrary error detail.
        setStatus("OTA retention failed");
      } finally {
        setBusy(false);
      }
    };
    return h(
      "section",
      null,
      h("h2", null, "OTA retained data"),
      h("p", { role: "status" }, status),
      summary && h("p", null, JSON.stringify(summary)),
      h(Button, { disabled: busy, onClick: () => void perform(true) }, "Seed OTA data"),
      h(Button, { disabled: busy, onClick: () => void perform(false) }, "Verify OTA data"),
    );
  }
  context.views.register("main", Retention);
}
