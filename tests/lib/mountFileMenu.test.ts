import { describe, expect, it } from "vitest";
import { selectMountedDirectory, type MountedDirectory } from "@/lib/plugins/mountFileMenu";

const mount = (id: string, remotePath: string, sessionId = "one"): MountedDirectory => ({
  id,
  remotePath,
  sessionId,
  mountPoint: `/mount/${id}`,
});

describe("mounted directory selection", () => {
  it("uses the deepest matching mount in the active session", () => {
    const mounts = [
      mount("root", "/"),
      mount("nested", "/home/user"),
      mount("other", "/home/user", "two"),
    ];
    expect(selectMountedDirectory(mounts, "one", "/home/user/file")?.id).toBe("nested");
    expect(selectMountedDirectory(mounts, "two", "/home/user/file")?.id).toBe("other");
    expect(selectMountedDirectory(mounts, "one", "/elsewhere")?.id).toBe("root");
  });
  it("rejects sibling prefixes, disconnected mounts and unsafe paths", () => {
    const mounts = [
      mount("data", "/srv/data"),
      { ...mount("failed", "/srv"), cleanupError: "closed" },
    ];
    expect(selectMountedDirectory(mounts, "one", "/srv/database/file")).toBeUndefined();
    expect(selectMountedDirectory(mounts, "one", "/srv/data/../secret")).toBeUndefined();
    expect(selectMountedDirectory(mounts, "one", "/srv/data\\secret")).toBeUndefined();
    expect(selectMountedDirectory(mounts, "one", "/srv/data/a\\b")?.id).toBe("data");
    expect(selectMountedDirectory(mounts, "one", "relative")).toBeUndefined();
    expect(selectMountedDirectory(mounts, "one", "/srv/data\0secret")).toBeUndefined();
    expect(selectMountedDirectory(mounts, "one", "/srv/data/")?.id).toBe("data");
  });
});
