import { beforeEach, describe, expect, it, vi } from "vitest";

const { reorder, update, snapshot } = vi.hoisted(() => ({
  reorder: vi.fn(),
  update: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("@/lib/api/ipc", () => ({
  api: {
    hostsReorder: reorder,
    hostsSnapshot: snapshot,
    updateHost: update,
  },
}));

import "@/i18n/i18n";
import type { Host } from "@/lib/api/types";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";

const host = (id: string, sortOrder: number): Host => ({
  id,
  groupId: null,
  name: id,
  host: `${id}.example.com`,
  port: 22,
  username: "root",
  authMethod: "password",
  keyPath: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

beforeEach(() => {
  reorder.mockReset().mockResolvedValue(undefined);
  update.mockReset().mockResolvedValue(undefined);
  snapshot.mockReset();
  useHosts.setState({ hosts: [host("alpha", 0), host("beta", 1), host("gamma", 2)] });
});

describe("host ordering", () => {
  it("keeps current discovery during saved-host reload and excludes it from mutations", async () => {
    const discovered = {
      ...host("source:digest", 0),
      source: {
        pluginId: "inventory",
        pluginName: "Inventory",
        id: "cloud",
        label: "Cloud",
        entryId: "one",
      },
    };
    useHosts.getState().setSourceHosts([discovered]);
    let accept!: (value: { hosts: Host[]; groups: [] }) => void;
    snapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const loading = useHosts.getState().load();
    useHosts.getState().setSourceHosts([]);
    accept({ hosts: [host("alpha", 0)], groups: [] });
    await loading;
    expect(useHosts.getState().hosts.map((host) => host.id)).toEqual(["alpha"]);
    useHosts.getState().setSourceHosts([discovered]);
    useHosts.getState().moveHost(discovered.id, "alpha");
    useHosts.getState().moveToGroup(discovered.id, null, true);
    await useHosts.getState().toggleFavorite(discovered);
    expect(await useHosts.getState().updateHost(discovered.id, discovered)).toBeNull();
    expect(await useHosts.getState().deleteHost(discovered.id)).toBe(false);
    expect(reorder).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    snapshot.mockResolvedValue({ hosts: [host("alpha", 0)], groups: [] });
    await useHosts.getState().load();
    expect(useHosts.getState().hosts.map((host) => host.id)).toEqual(["alpha", discovered.id]);
  });
  it("publishes a saved rename immediately while the host snapshot is still loading", async () => {
    let resolveSnapshot!: (value: { hosts: Host[]; groups: [] }) => void;
    snapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const original = host("alpha", 0);
    const renamed = { ...original, name: "Renamed" };
    update.mockResolvedValue(renamed);
    useSsh.setState({
      sessions: [
        {
          id: "ssh",
          hostId: "alpha",
          title: "alpha",
          address: "root@alpha.example.com:22",
          cols: 80,
          rows: 24,
          connectedAt: 1,
        },
      ],
    });
    const saving = useHosts.getState().updateHost("alpha", { ...renamed });
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
    expect(useHosts.getState().hosts[0]?.name).toBe("Renamed");
    expect(useSsh.getState().sessions[0]?.title).toBe("Renamed");
    resolveSnapshot({ hosts: [renamed], groups: [] });
    await saving;
  });
  it("moves a host in front of the drop target", () => {
    useHosts.getState().moveHost("gamma", "alpha");
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["gamma", "alpha", "beta"]);
    expect(reorder).toHaveBeenCalledWith(["gamma", "alpha", "beta"]);
  });

  it("ignores a drop on itself or an unknown target", () => {
    useHosts.getState().moveHost("alpha", "alpha");
    useHosts.getState().moveHost("alpha", "missing");
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(reorder).not.toHaveBeenCalled();
  });

  it("inserts after the target and adopts its group", async () => {
    useHosts.setState({
      hosts: [{ ...host("alpha", 0), groupId: "g1" }, host("beta", 1), host("gamma", 2)],
    });
    useHosts.getState().moveHost("gamma", "alpha", "after");
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["alpha", "gamma", "beta"]);
    expect(useHosts.getState().hosts.find((item) => item.id === "gamma")?.groupId).toBe("g1");
    expect(update).toHaveBeenCalledWith("gamma", expect.objectContaining({ groupId: "g1" }));
    await vi.waitFor(() => expect(reorder).toHaveBeenCalledWith(["alpha", "gamma", "beta"]));
  });

  it("serializes rapid drops while keeping the newest visible order", async () => {
    let finish!: () => void;
    reorder.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    useHosts.getState().moveHost("gamma", "alpha");
    useHosts.getState().moveHost("beta", "gamma");
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["beta", "gamma", "alpha"]);
    finish();
    await vi.waitFor(() => expect(reorder).toHaveBeenCalledTimes(2));
    expect(reorder).toHaveBeenLastCalledWith(["beta", "gamma", "alpha"]);
  });

  it("does not let an old snapshot undo a later drag", async () => {
    let finish!: (value: { groups: []; hosts: Host[] }) => void;
    snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const loading = useHosts.getState().load();
    useHosts.getState().moveHost("gamma", "alpha");
    finish({ groups: [], hosts: [host("alpha", 0), host("beta", 1), host("gamma", 2)] });
    await loading;
    expect(useHosts.getState().hosts.map((item) => item.id)).toEqual(["gamma", "alpha", "beta"]);
  });
});
