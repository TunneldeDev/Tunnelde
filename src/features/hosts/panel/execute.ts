import type { HostPanelCommand, HostPanelTarget } from "./protocol";
import { hostPanelSource } from "./source";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";
import { useDialogs } from "@/store/dialogs";
import { useHostTransfer } from "@/lib/hosts/transfer";
import { usePlugins } from "@/store/plugins";
import { hostMenuCommands, runHostMenuCommand } from "@/lib/plugins/hostMenu";
import { defaultHostListPreferences, moveHostColumn } from "@/lib/hosts/columns";
import { savedHostInput } from "@/lib/hosts/sources";
import { connectHostDirectly } from "@/lib/session/connectHost";
import { copyText } from "@/lib/session/clipboard";
import { create } from "zustand";
import i18n from "@/i18n/i18n";

// Main owns credentials, import/export and modal drafts independently of the
// movable host list. Satellite actions deliberately reveal the main dialog.
export const useHostPanelDialogs = create<{ sshImport: boolean }>(() => ({ sshImport: false }));
export function resolveHostTarget(target: HostPanelTarget) {
  const data = hostPanelSource.snapshot();
  if (!target || data.hostTargets[target.id]?.revision !== target.revision)
    throw new Error("pluginView.hostChanged");
  return data.hosts.find((host) => host.id === target.id)!;
}
function resolveGroup(target: HostPanelTarget) {
  const data = hostPanelSource.snapshot();
  if (!target || data.groupTargets[target.id]?.revision !== target.revision)
    throw new Error("pluginView.hostChanged");
  return data.groups.find((group) => group.id === target.id)!;
}
function dialogAvailable() {
  if (
    useDialogs.getState().dialog.kind !== "none" ||
    useHostPanelDialogs.getState().sshImport ||
    useHostTransfer.getState().dialog !== null
  )
    throw new Error("dialog.busy");
}
export async function executeHostPanelCommand(
  command: HostPanelCommand,
  showMain?: () => Promise<unknown>,
) {
  const store = useHosts.getState();
  if ("host" in command) resolveHostTarget(command.host);
  if ("group" in command && command.group) resolveGroup(command.group);
  const reveal = async () => {
    dialogAvailable();
    await showMain?.();
    dialogAvailable();
  };
  const settings = useSettings.getState();
  const prefs = settings.settings.hostList;
  const update = (patch: Partial<typeof prefs>) =>
    settings.update({ hostList: { ...prefs, ...patch } });
  switch (command.operation) {
    case "view":
      return update({ view: command.view });
    case "resetColumns":
      return update({ ...defaultHostListPreferences(), view: prefs.view });
    case "column":
    case "resizeColumn":
    case "moveColumn": {
      const columns = [
        "name",
        "address",
        "user",
        "port",
        "group",
        ...hostPanelSource.snapshot().columns.map((c) => c.key),
      ];
      if (command.operation === "moveColumn") {
        if (!columns.includes(command.from) || !columns.includes(command.to))
          throw new Error("pluginView.hostChanged");
        return update({
          order: moveHostColumn(
            [...new Set([...prefs.order, ...columns])],
            command.from,
            command.to,
          ),
        });
      }
      if (!columns.includes(command.key)) throw new Error("pluginView.hostChanged");
      if (command.operation === "resizeColumn")
        return update({
          widths: { ...prefs.widths, [command.key]: Math.max(64, Math.min(480, command.width)) },
        });
      if (command.command === "toggle")
        return command.key === "name"
          ? true
          : update({
              hidden: prefs.hidden.includes(command.key)
                ? prefs.hidden.filter((k) => k !== command.key)
                : [...prefs.hidden, command.key],
            });
      return update({
        sort:
          prefs.sort?.key === command.key && prefs.sort.direction === "desc"
            ? null
            : {
                key: command.key,
                direction:
                  prefs.sort?.key === command.key && prefs.sort.direction === "asc"
                    ? "desc"
                    : "asc",
              },
      });
    }
    case "newHost":
      if (showMain) await reveal();
      else dialogAvailable();
      useDialogs
        .getState()
        .openHost(null, command.group ? resolveGroup(command.group).id : undefined);
      return true;
    case "newGroup":
      if (showMain) await reveal();
      else dialogAvailable();
      useDialogs.getState().openGroup();
      return true;
    case "importSsh":
      if (showMain) await reveal();
      else dialogAvailable();
      useHostPanelDialogs.setState({ sshImport: true });
      return true;
    case "import":
      if (showMain) await reveal();
      else dialogAvailable();
      useHostTransfer.getState().openImport();
      return true;
    case "exportAll":
      if (showMain) await reveal();
      else dialogAvailable();
      useHostTransfer.getState().openExport();
      return true;
    case "editGroup":
      if (showMain) await reveal();
      else dialogAvailable();
      useDialogs.getState().openGroup(resolveGroup(command.group));
      return true;
    case "deleteGroup": {
      if (showMain) await reveal();
      else dialogAvailable();
      const group = resolveGroup(command.group);
      useDialogs.getState().confirm({
        title: i18n.t("group.deleteTitle"),
        body: i18n.t("group.deleteBody", { name: group.name }),
        confirmLabel: i18n.t("common.delete"),
        danger: true,
        onConfirm: async () => {
          resolveGroup(command.group);
          await store.deleteGroup(group.id);
        },
      });
      return true;
    }
    case "move": {
      const host = resolveHostTarget(command.host),
        target = resolveHostTarget(command.target);
      if (host.source || target.source) throw new Error("pluginView.hostChanged");
      store.moveHost(host.id, target.id, command.position);
      return true;
    }
    case "moveToGroup": {
      const host = resolveHostTarget(command.host);
      if (host.source) throw new Error("pluginView.hostChanged");
      store.moveToGroup(
        host.id,
        command.group ? resolveGroup(command.group).id : null,
        command.favorite,
      );
      return true;
    }
  }
  let host = resolveHostTarget(command.host);
  const mutable = () => {
    host = resolveHostTarget(command.host);
    if (host.source) throw new Error("pluginView.hostChanged");
    return host;
  };
  switch (command.operation) {
    case "favorite":
      await store.toggleFavorite(mutable());
      return true;
    case "copyAddress":
    case "copySsh": {
      const quote = (v: string) =>
        /^[A-Za-z0-9_.:@%[\]-]+$/.test(v)
          ? v
          : hostPanelSource.snapshot().platform === "windows"
            ? `'${v.replaceAll("'", "''")}'`
            : `'${v.replaceAll("'", `'"'"'`)}'`;
      const text =
        command.operation === "copyAddress"
          ? `${host.username ? `${host.username}@` : ""}${host.host.includes(":") && !host.host.startsWith("[") ? `[${host.host}]` : host.host}`
          : [
              "ssh",
              ...(host.port !== 22 ? ["-p", String(host.port)] : []),
              ...(host.username ? ["-l", quote(host.username)] : []),
              ...(host.authMethod === "key" && host.keyPath ? ["-i", quote(host.keyPath)] : []),
              "--",
              quote(host.host),
            ].join(" ");
      await copyText(text);
      return true;
    }
    case "plugin": {
      const action = hostMenuCommands(usePlugins.getState().items).find(
        (a) =>
          a.pluginId === command.pluginId &&
          a.command === command.command &&
          (a.fingerprint ?? null) === command.fingerprint,
      );
      if (!action) throw new Error("pluginSecurity.changed");
      if (showMain) await reveal();
      else dialogAvailable();
      host = resolveHostTarget(command.host);
      // Singleton command/consent and output are main-owned, not transferable
      // panel work that could outlive a source-window effect fence.
      void runHostMenuCommand(action, host);
      return true;
    }
    case "saveCopy": {
      if (!host.source) throw new Error("pluginView.hostChanged");
      const copy = await store.createHost(savedHostInput(host));
      if (!copy) return false;
      await showMain?.();
      useWorkspace.getState().openHost(copy);
      return true;
    }
    default:
      if (showMain) await reveal();
      else dialogAvailable();
      host = resolveHostTarget(command.host);
  }
  switch (command.operation) {
    case "export":
      mutable();
      useHostTransfer.getState().openExport([host.id]);
      break;
    case "open":
      useWorkspace.getState().openHost(host);
      break;
    case "edit":
      useDialogs.getState().openHost(mutable());
      break;
    case "delete":
      mutable();
      useDialogs.getState().confirm({
        title: i18n.t("host.deleteTitle"),
        body: i18n.t("host.deleteBody", { name: host.name }),
        confirmLabel: i18n.t("common.delete"),
        danger: true,
        onConfirm: async () => {
          const current = mutable();
          if (await store.deleteHost(current.id)) useWorkspace.getState().removeHost(current.id);
        },
      });
      break;
    case "activate": {
      const mode = useSettings.getState().settings.hostActivation;
      if (mode === "details") useWorkspace.getState().openHost(host, { preview: true });
      else if (mode === "edit") useDialogs.getState().openHost(host);
      else if (useSettings.getState().settings.hostDirectConnect) void connectHostDirectly(host);
      else useDialogs.getState().openConnect(host, "terminal");
      break;
    }
    case "connect":
      if (useSettings.getState().settings.hostDirectConnect) void connectHostDirectly(host);
      else useDialogs.getState().openConnect(host, "terminal");
      break;
    case "sftp":
      useDialogs.getState().openConnect(host, "sftp");
      break;
    case "installKey":
      mutable();
      useDialogs.getState().openConnect(host, "terminal", "installKey");
      break;
  }
  return true;
}
