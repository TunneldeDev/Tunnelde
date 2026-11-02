import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  PluginPermissionGate,
  PluginRecoveryPrompt,
} from "@/features/plugins/PluginPermissionGate";
import {
  PluginSecurityBadge,
  PluginSecuritySection,
} from "@/features/plugins/PluginSecuritySection";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { useDialogs } from "@/store/dialogs";
import { plugin } from "../fixtures/plugins";
const nodeGate = vi.hoisted(() => vi.fn(() => false));
vi.mock("@/features/plugins/NodeRuntimeSection", () => ({ useNodeRuntimeGateOpen: nodeGate }));
const load = vi.fn(async () => {}),
  approve = vi.fn(async () => true),
  deny = vi.fn(),
  restrict = vi.fn(async () => true),
  revoke = vi.fn(async () => true);
beforeEach(async () => {
  vi.clearAllMocks();
  nodeGate.mockReturnValue(false);
  await i18n.changeLanguage("en-US");
  usePluginSecurity.setState({
    ...usePluginSecurity.getInitialState(),
    ready: true,
    load,
    approve,
    deny,
    setRestricted: restrict,
    revoke,
  });
  useDialogs.setState({ dialog: { kind: "none" } });
});
describe("plugin security interactions", () => {
  it("offers one-time recovery choices without stacking over permission or Node dialogs", () => {
    usePluginSecurity.setState({
      recoveryPrompt: "failure",
      failure: "Plugin timed out",
      prompts: [plugin],
    });
    const view = render(<PluginRecoveryPrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => usePluginSecurity.setState({ prompts: [] }));
    nodeGate.mockReturnValue(true);
    view.rerender(<PluginRecoveryPrompt />);
    expect(screen.queryByRole("dialog")).toBeNull();
    nodeGate.mockReturnValue(false);
    view.rerender(<PluginRecoveryPrompt />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains protected startup and keeps restricted mode unless the user later changes settings", () => {
    usePluginSecurity.setState({
      recoveryPrompt: "startup",
      state: {
        restricted: true,
        cliLocked: false,
        recoverySuggested: true,
        reason: null,
        grants: {},
      },
    });
    render(<PluginRecoveryPrompt />);
    expect(screen.getByText(/started in restricted mode/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep restricted mode" }));
    expect(restrict).not.toHaveBeenCalled();
    expect(usePluginSecurity.getState().state.restricted).toBe(true);
  });
  it("does not show a permission modal without an explicit pending execution request", () => {
    render(<PluginPermissionGate />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("queues permission approval until the current application dialog closes", () => {
    useDialogs.getState().confirm({
      title: "Existing confirmation",
      body: "Finish this action first",
      confirmLabel: "Continue",
      onConfirm: vi.fn(),
    });
    render(<PluginPermissionGate />);
    act(() => usePluginSecurity.setState({ prompts: [plugin] }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(usePluginSecurity.getState().prompts).toEqual([plugin]);
    expect(approve).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
    act(() => useDialogs.getState().close());
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow and continue" }));
    expect(approve).toHaveBeenCalledWith(plugin.id);
  });
  it("explains each requested capability and Node process access before allowing execution", () => {
    usePluginSecurity.setState({
      prompts: [{ ...plugin, permissions: ["clipboard.read", "ssh.exec", "monitor.write"] }],
    });
    render(<PluginPermissionGate />);
    expect(screen.getByText("Read your clipboard contents.")).toBeTruthy();
    expect(screen.getByText(/send terminal input/)).toBeTruthy();
    expect(screen.getByText(/including ending them/)).toBeTruthy();
    expect(screen.getByText(/do not sandbox Node/)).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Allow and continue" }));
    expect(approve).toHaveBeenCalledWith(plugin.id);
  });
  it("requires consent for executable plugins with no host permissions and offers deny/restricted actions", () => {
    usePluginSecurity.setState({ prompts: [plugin] });
    render(<PluginPermissionGate />);
    expect(screen.getByText(/Executable code still requires your approval/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(deny).toHaveBeenCalledWith(plugin.id);
    fireEvent.click(screen.getByRole("button", { name: "Enter restricted mode" }));
    expect(restrict).toHaveBeenCalledWith(true);
  });
  it("cannot dismiss or approve a request while its grant is being saved", () => {
    usePluginSecurity.setState({ prompts: [plugin], busy: true });
    render(<PluginPermissionGate />);
    expect(
      (screen.getByRole("button", { name: "Allow and continue" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(deny).not.toHaveBeenCalled();
  });
  it("shows a locked CLI restriction, lists approvals and provides revocation", () => {
    usePluginSecurity.setState({
      state: {
        restricted: true,
        cliLocked: true,
        recoverySuggested: false,
        reason: null,
        grants: { formatter: [] },
      },
    });
    render(<PluginSecuritySection />);
    expect(
      (screen.getByRole("switch", { name: "Restricted mode" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Restart without that argument/)).toBeTruthy();
    fireEvent.click(screen.getByText("Approved plugins"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke approval" }));
    expect(revoke).toHaveBeenCalledWith("formatter");
  });
  it("collapses approvals and groups plugin permissions without omitting unknown capabilities", async () => {
    usePluginSecurity.setState({
      state: {
        restricted: false,
        cliLocked: false,
        recoverySuggested: false,
        reason: null,
        grants: { formatter: ["fs.read", "ssh.exec", "process.exec", "secrets", "future.unknown"] },
      },
    });
    const { container } = render(<PluginSecuritySection />);
    const collection = container.querySelector<HTMLDetailsElement>(".plugin-security__approvals")!;
    expect(collection.open).toBe(false);
    expect(screen.queryByText("fs.read")).toBeNull();
    fireEvent.click(screen.getByText("Approved plugins"));
    expect(collection.open).toBe(true);
    fireEvent.click(container.querySelector(".plugin-security__grant summary")!);
    await waitFor(() => expect(screen.getByText("fs.read")).toBeTruthy());
    expect(screen.getByText("Local files")).toBeTruthy();
    expect(screen.getByText("Remote machines")).toBeTruthy();
    expect(screen.getByText("Execution and network")).toBeTruthy();
    expect(screen.getByText("Other capabilities")).toBeTruthy();
    expect(screen.getByText("future.unknown")).toBeTruthy();
    expect(screen.getByText("Launch and control executable processes.")).toBeTruthy();
    expect(
      [...container.querySelectorAll<HTMLDetailsElement>(".plugin-security__group")].every(
        (group) => !group.open,
      ),
    ).toBe(true);
    fireEvent.click(container.querySelector(".plugin-security__grant summary")!);
    await waitFor(() => expect(screen.queryByText("fs.read")).toBeNull());
  });
  it("shows recoverable failures without opening a modal and makes safety settings discoverable", () => {
    const open = vi.fn(),
      select = vi.fn();
    useWorkspace.setState({ openPage: open });
    useNavigation.setState({ selectSettings: select });
    usePluginSecurity.setState({ failure: "Plugin timed out" });
    render(
      <>
        <PluginSecurityBadge />
        <PluginSecuritySection />
        <PluginPermissionGate />
      </>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Plugin timed out")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review plugin safety" }));
    expect(select).toHaveBeenCalledWith("plugins");
    expect(open).toHaveBeenCalledWith("settings");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(screen.queryByText("Plugin timed out")).toBeNull();
    expect(screen.queryByRole("button", { name: "Review plugin safety" })).toBeNull();
  });
});
