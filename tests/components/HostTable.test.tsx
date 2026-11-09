import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { HostTableHeader, HostListViewMenu } from "@/components/layout/HostTable";
import { defaultHostListPreferences, type DisplayHostColumn } from "@/lib/hosts/columns";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
const originalUpdate = useSettings.getState().update;
const columns: DisplayHostColumn[] = [
  { key: "name", label: "Name", width: 200, type: "text", values: new Map() },
  { key: "address", label: "Address", width: 180, type: "text", values: new Map() },
];
beforeEach(() =>
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, hostList: { ...defaultHostListPreferences(), view: "table" } },
    update: vi.fn(async (patch) => {
      useSettings.setState((state) => ({ settings: { ...state.settings, ...patch } }));
      return true;
    }),
  }),
);
afterEach(() => useSettings.setState({ update: originalUpdate }));
describe("host table persisted preferences", () => {
  it("cycles sort through ascending, descending and default and prevents hiding host identity", () => {
    render(
      <>
        <HostListViewMenu columns={columns} />
        <HostTableHeader columns={columns} allColumns={columns} />
      </>,
    );
    const button = screen.getByRole("button", { name: "Address" });
    for (const expected of ["asc", "desc", undefined]) {
      fireEvent.click(button);
      expect(useSettings.getState().settings.hostList.sort?.direction).toBe(expected);
    }
    fireEvent.click(screen.getByRole("button", { name: "Host view and columns" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Name" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Address" }));
    expect(useSettings.getState().settings.hostList.hidden).toContain("address");
  });
  it("commits a resized width against the latest settings and restores the CSS preview on failed save", async () => {
    render(
      <div
        className="host-table"
        style={{ "--host-columns": "200px 180px" } as React.CSSProperties}
      >
        <HostTableHeader columns={columns} allColumns={columns} />
      </div>,
    );
    const handle = screen.getByRole("separator", { name: "Resize Address column" });
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(handle, event);
    };
    pointer("pointerdown", 100);
    pointer("pointermove", 150);
    act(() =>
      useSettings.setState((state) => ({
        settings: {
          ...state.settings,
          hostList: { ...state.settings.hostList, hidden: ["port"], widths: { name: 210 } },
        },
      })),
    );
    await act(async () => pointer("pointerup", 150));
    expect(useSettings.getState().settings.hostList).toMatchObject({
      hidden: ["port"],
      widths: { name: 210, address: 230 },
    });
    useSettings.setState({ update: vi.fn(async () => false) });
    pointer("pointerdown", 100);
    pointer("pointermove", 200);
    await act(async () => pointer("pointerup", 200));
    expect(
      document.querySelector<HTMLElement>(".host-table")?.style.getPropertyValue("--host-columns"),
    ).toBe("210px 230px");
  });
});
