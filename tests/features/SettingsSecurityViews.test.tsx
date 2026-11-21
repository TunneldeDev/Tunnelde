import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  PluginSecuritySectionView,
  type PluginSecurityData,
  type PluginSecurityServices,
} from "@/features/plugins/components/PluginSecuritySectionView";
import {
  NodeRuntimeSectionView,
  type NodeRuntimeData,
  type NodeRuntimeServices,
} from "@/features/plugins/components/NodeRuntimeSectionView";

vi.mock("@/store/pluginSecurity", () => {
  throw new Error("Security view imported main grant owner");
});
vi.mock("@/store/plugins", () => {
  throw new Error("Security view imported main plugin owner");
});
vi.mock("@/store/dialogs", () => {
  throw new Error("Security view imported main consent owner");
});
vi.mock("@/store/navigation", () => {
  throw new Error("Security view imported main navigation");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("Security view imported direct IPC");
});

function securityFixture() {
  const data: PluginSecurityData = {
    state: {
      restricted: false,
      cliLocked: false,
      recoverySuggested: false,
      reason: null,
      grants: { example: ["bus.communicate", "unknown.capability"] },
    },
    ready: true,
    loading: false,
    busy: false,
    error: null,
    failure: null,
    recoveryDismissed: false,
    plugins: [{ id: "example", name: "Example" }],
  };
  const captured = new Map<string, unknown>();
  const services: PluginSecurityServices = {
    useData: () => data,
    useViewState<T>(key: string, initial: T) {
      const [value, setValue] = useState<T>(() =>
        captured.has(key) ? (captured.get(key) as T) : initial,
      );
      captured.set(key, value);
      return [value, setValue];
    },
    useBusyGuard: vi.fn(),
    load: vi.fn(async () => {}),
    setRestricted: vi.fn(async () => true),
    revoke: vi.fn(async () => true),
    dismissRecovery: vi.fn(),
    copyError: vi.fn(),
  };
  return { data, captured, services };
}
function runtimeFixture() {
  const data: NodeRuntimeData = {
    info: {
      path: "/system/node",
      version: null,
      source: "path",
      compatible: false,
      minimumMajor: 22,
      issue: "node.consentRequired",
    },
    busy: null,
    error: null,
    progress: null,
    cancelling: false,
    nativeAvailable: true,
  };
  const services: NodeRuntimeServices = {
    useData: () => data,
    useBusyGuard: vi.fn(),
    load: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    choose: vi.fn(async () => {}),
    allowSystem: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    confirm: vi.fn(),
  };
  return { data, services };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("security and Node runtime independent settings renderers", () => {
  it("restores grants disclosure without granting or revoking anything and retains unknown permissions", () => {
    const owner = securityFixture();
    owner.captured.set("settings:security:approvals", true);
    owner.captured.set("settings:security:grants", { example: true });
    const { container } = render(<PluginSecuritySectionView services={owner.services} />);
    expect(container.querySelector<HTMLDetailsElement>(".plugin-security__approvals")?.open).toBe(
      true,
    );
    expect(screen.getByText("unknown.capability")).toBeTruthy();
    expect(screen.getByText("bus.communicate")).toBeTruthy();
    expect(owner.services.setRestricted).not.toHaveBeenCalled();
    expect(owner.services.revoke).not.toHaveBeenCalled();
  });

  it("delegates explicit restriction/revocation and respects CLI locks", () => {
    const owner = securityFixture();
    owner.captured.set("settings:security:approvals", true);
    const view = render(<PluginSecuritySectionView services={owner.services} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(owner.services.setRestricted).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pluginSecurity.revoke") }));
    expect(owner.services.revoke).toHaveBeenCalledWith("example");
    owner.data.state.cliLocked = true;
    view.rerender(<PluginSecuritySectionView services={owner.services} />);
    expect(screen.getByRole("switch")).toHaveProperty("disabled", true);
  });

  it("keeps failure recovery as explicit actions while in-flight owner writes block release", () => {
    const owner = securityFixture();
    owner.data.failure = "Fixture failure";
    owner.data.busy = true;
    render(<PluginSecuritySectionView services={owner.services} />);
    expect(screen.getByText("Fixture failure")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: i18n.t("pluginSecurity.enterRestricted") }),
    ).toHaveProperty("disabled", true);
    expect(owner.services.useBusyGuard).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("pluginSecurity.dismiss") }));
    expect(owner.services.dismissRecovery).toHaveBeenCalledOnce();
  });

  it("does not install or approve a detected system runtime until owner confirmation", async () => {
    const owner = runtimeFixture();
    render(<NodeRuntimeSectionView services={owner.services} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.node.install") }));
    expect(owner.services.install).not.toHaveBeenCalled();
    await act(async () => vi.mocked(owner.services.confirm).mock.calls[0]![0].onConfirm());
    expect(owner.services.install).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.node.useDetected") }));
    expect(owner.services.allowSystem).not.toHaveBeenCalled();
    await act(async () => vi.mocked(owner.services.confirm).mock.calls[1]![0].onConfirm());
    expect(owner.services.allowSystem).toHaveBeenCalledWith(true);
  });

  it("renders an existing owner installation across remount without restarting it and delegates cancellation", () => {
    const owner = runtimeFixture();
    owner.data.busy = "installing";
    owner.data.progress = { taskId: "existing", phase: "downloading", received: 50, total: 100 };
    const view = render(<NodeRuntimeSectionView services={owner.services} />);
    expect(screen.getByRole("progressbar")).toHaveProperty("value", 50);
    view.unmount();
    render(<NodeRuntimeSectionView services={owner.services} />);
    expect(screen.getByRole("progressbar")).toHaveProperty("value", 50);
    expect(owner.services.install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.node.cancel") }));
    expect(owner.services.cancel).toHaveBeenCalledOnce();
  });

  it("routes detection and path choices through the owner and reports readiness only after completion", () => {
    const owner = runtimeFixture();
    const ready = vi.fn();
    const view = render(<NodeRuntimeSectionView services={owner.services} onReady={ready} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.node.recheck") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.node.choose") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("plugins.node.automatic") }));
    expect(owner.services.check).toHaveBeenCalledOnce();
    expect(owner.services.choose).toHaveBeenNthCalledWith(1);
    expect(owner.services.choose).toHaveBeenNthCalledWith(2, true);
    expect(ready).not.toHaveBeenCalled();
    owner.data.info = { ...owner.data.info!, compatible: true };
    owner.data.busy = "checking";
    view.rerender(<NodeRuntimeSectionView services={owner.services} onReady={ready} />);
    expect(ready).not.toHaveBeenCalled();
    owner.data.busy = null;
    view.rerender(<NodeRuntimeSectionView services={owner.services} onReady={ready} />);
    expect(ready).toHaveBeenCalledOnce();
  });
});
