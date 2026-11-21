import "@/i18n/i18n";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostPageView, type HostPageServices } from "@/features/hosts/HostPage";
import type { Host } from "@/lib/api/types";
const host: Host = {
  id: "a",
  name: "Production",
  host: "server.invalid",
  port: 2222,
  username: "dev",
  authMethod: "key",
  keyPath: "/display/key",
  groupId: "g",
  favorite: false,
  color: null,
  tags: ["web"],
  note: "Metadata",
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 1,
  updatedAt: 1,
};
const services = (): HostPageServices => ({
  connect: vi.fn(),
  sftp: vi.fn(),
  favorite: vi.fn(),
  edit: vi.fn(),
  remove: vi.fn(),
  duplicate: vi.fn(),
});
afterEach(cleanup);
it("renders the complete production metadata and injected sections, routing all effects explicitly", () => {
  const effects = services();
  render(
    <HostPageView host={host} groupName="Servers" hostCount={2} services={effects}>
      <section>Forwarding and plugin sections</section>
    </HostPageView>,
  );
  expect(screen.getByRole("heading", { name: "Production" })).toBeTruthy();
  for (const text of [
    "Servers",
    "/display/key",
    "web",
    "Metadata",
    "Forwarding and plugin sections",
  ])
    expect(screen.getByText(text)).toBeTruthy();
  const labels = [
    [/^Connect$/, "connect"],
    [/^Files$/, "sftp"],
    [/^Add to favorites$/, "favorite"],
    [/^Edit$/, "edit"],
    [/^Delete$/, "remove"],
    [/^Duplicate$/, "duplicate"],
  ] as const;
  for (const [name, key] of labels) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(effects[key]).toHaveBeenCalledOnce();
  }
});
it("preserves discovery-host restrictions and offers an explicit saved copy", () => {
  const effects = services();
  render(
    <HostPageView
      host={{
        ...host,
        source: { pluginId: "p", pluginName: "Discovery", id: "s", entryId: "a", label: "Fleet" },
      }}
      hostCount={1}
      services={effects}
    />,
  );
  expect(screen.queryByRole("button", { name: /^Delete$/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Save as my host$/ }));
  expect(effects.duplicate).toHaveBeenCalledOnce();
});
it("renders a deleted host as an empty page, never stale clickable metadata", () => {
  render(<HostPageView host={null} hostCount={0} services={services()} />);
  expect(screen.queryAllByRole("button")).toHaveLength(0);
});
