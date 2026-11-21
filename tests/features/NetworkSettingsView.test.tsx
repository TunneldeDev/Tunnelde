import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  NetworkSettingsView,
  type NetworkSettingsServices,
} from "@/features/settings/components/NetworkSettingsView";
import { NetworkConnectionTestView } from "@/features/settings/components/NetworkConnectionTestView";
import { LogSettingsView } from "@/features/settings/components/LogSettingsView";
import { changeNetworkRoute } from "@/features/settings/data/networkMutations";
import type { NetworkConnectionQuality, NetworkSettings } from "@/lib/api/network";

vi.mock("@/store/settings", () => {
  throw new Error("Network view imported main settings owner");
});
vi.mock("@/store/plugins", () => {
  throw new Error("Network view imported main plugin owner");
});
vi.mock("@/store/navigation", () => {
  throw new Error("Network view imported main navigation");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("Network view imported direct IPC");
});
const profile = {
  id: "office",
  name: "Office",
  protocol: "http" as const,
  host: "127.0.0.1",
  port: 7890,
  username: "",
};
const network: NetworkSettings = {
  profiles: [profile],
  defaultProxy: "system",
  features: { ssh: "direct" },
};
const quality: NetworkConnectionQuality = {
  attempts: 3,
  successful: 3,
  samplesMs: [22, 30, 26],
  medianMs: 26,
  minMs: 22,
  maxMs: 30,
  spreadMs: 8,
  quality: "fast",
  lastError: null,
};
function fixture() {
  const viewKeys: string[] = [],
    secretKeys: string[] = [];
  const saveProfile = vi.fn<NetworkSettingsServices["saveProfile"]>(async () => ({
    credentialError: null,
  }));
  const services: NetworkSettingsServices = {
    useViewState<T>(key: string, initial: T) {
      viewKeys.push(key);
      return useState(initial);
    },
    useSecretState<T>(key: string, initial: T) {
      secretKeys.push(key);
      return useState(initial);
    },
    useBusyGuard: vi.fn(),
    setDefaultProxy: vi.fn(async () => true),
    setFeatureProxy: vi.fn(async () => true),
    removeProfile: vi.fn(async () => true),
    saveProfile,
    renderConnectionTest: () => <div data-testid="network-test" />,
  };
  return { services, saveProfile, viewKeys, secretKeys };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("network settings explicit owner boundary", () => {
  it("separates secret drafts from capturable fields and submits them only to the credential owner", async () => {
    const owner = fixture();
    render(<NetworkSettingsView settings={network} plugins={[]} services={owner.services} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "ephemeral-fixture" } });
    expect(owner.viewKeys).not.toContain("network:password");
    expect(owner.secretKeys).toContain("network:password");
    expect(owner.saveProfile).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(owner.saveProfile).toHaveBeenCalledWith({
      profile,
      credential: { action: "save", password: "ephemeral-fixture" },
    });
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(owner.services.setFeatureProxy).not.toHaveBeenCalled();
  });

  it("retains credential-error drafts and discards cancelled passwords", async () => {
    const owner = fixture();
    owner.saveProfile.mockResolvedValueOnce({
      credentialError: new Error("Fixture vault unavailable"),
    });
    render(<NetworkSettingsView settings={network} plugins={[]} services={owner.services} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "ephemeral-fixture" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByRole("alert").textContent).toContain("Fixture vault unavailable");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("ephemeral-fixture");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  it("delegates narrow route commands and renders the supplied real test section", async () => {
    const owner = fixture();
    render(
      <NetworkSettingsView
        settings={network}
        plugins={[{ id: "fixture", name: "Fixture plugin" }]}
        services={owner.services}
      />,
    );
    expect(screen.getByTestId("network-test")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Application updates" }));
    fireEvent.click(screen.getByRole("option", { name: "Office" }));
    expect(owner.services.setFeatureProxy).toHaveBeenCalledWith("updates", "office");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(owner.services.removeProfile).toHaveBeenCalledWith("office");
    expect(owner.services.setDefaultProxy).not.toHaveBeenCalled();
  });

  it("merges route commands with current owner values and removes only references to the chosen profile", () => {
    const current = {
      ...network,
      defaultProxy: "office",
      features: { ...network.features, updates: "office", "plugin:other": "direct" },
    };
    expect(
      changeNetworkRoute(current, { kind: "feature", feature: "marketplace", value: "office" }),
    ).toEqual({ ...current, features: { ...current.features, marketplace: "office" } });
    expect(changeNetworkRoute(current, { kind: "remove", id: "office" })).toEqual({
      profiles: [],
      defaultProxy: "system",
      features: { ssh: "direct", updates: "", "plugin:other": "direct" },
    });
    expect(current.profiles).toHaveLength(1);
  });

  it("tests through the scoped owner and rejects stale results after the route changes", async () => {
    const test = vi.fn(async () => quality);
    const props = { settings: network, services: { test, useBusyGuard: vi.fn() } };
    const view = render(<NetworkConnectionTestView {...props} />);
    const form = within(screen.getByRole("form", { name: "Test connection" }));
    await act(async () => fireEvent.click(form.getByRole("button", { name: "Test connection" })));
    expect(test).toHaveBeenCalledWith("system", "github.com", 443);
    expect(form.getByText("26 ms", { selector: "dd" })).toBeTruthy();
    view.rerender(
      <NetworkConnectionTestView {...props} settings={{ ...network, defaultProxy: "direct" }} />,
    );
    expect(screen.queryByRole("region", { name: "Connection quality" })).toBeNull();
  });

  it("routes log navigation through a supplied effect", () => {
    const onShowOutput = vi.fn();
    render(<LogSettingsView onShowOutput={onShowOutput} />);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("output.show") }));
    expect(onShowOutput).toHaveBeenCalledOnce();
  });
});
