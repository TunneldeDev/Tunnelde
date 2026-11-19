import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { MountHostDetailsSettings } from "@/features/plugins/MountHostDetailsSettings";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { plugin } from "../fixtures/plugins";
vi.mock("@/lib/extensions/frontendRuntime", () => ({
  frontendRuntime: { ensure: vi.fn(), view: vi.fn() },
}));
it.each(["node", "declarative"] as const)(
  "selects a native %s mount contributor without loading trusted UI code",
  async (runtime) => {
    const update = vi.fn(async () => true);
    useSettings.setState({ update });
    usePlugins.setState({
      items: [
        {
          ...plugin,
          id: "mount",
          runtime,
          status: "running",
          runtimeId: "active",
          permissions: ["hosts.read", "mounts.read", "mounts.hostDetails"],
          views: [{ id: "main", title: "Mounts", kind: "sharedMounts" }],
          hostDetails: [{ id: "panel", viewId: "main", title: "Mounts", kind: "mounts" }],
        },
      ],
    });
    render(<MountHostDetailsSettings />);
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("option", { name: "Formatter · Mounts" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        mountHostDetailsSelection: { pluginId: "mount", contributionId: "panel" },
      }),
    );
    expect(frontendRuntime.ensure).not.toHaveBeenCalled();
  },
);
