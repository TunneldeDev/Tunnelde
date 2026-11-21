import { useState, type ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PreferenceSurfaceView,
  type PreferenceSurfaceServices,
} from "@/features/settings/components/PreferenceSurfaceView";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import type { PreferencesContext } from "@/lib/extensions/preferences/context";
import type { FrontendPreferences } from "@/lib/extensions/contracts/preferences/provider";
vi.mock("@/store/settings", () => {
  throw new Error("View imported main settings writer");
});
vi.mock("@/components/layout/ProviderSurface", () => {
  throw new Error("View imported main plugin runtime");
});
type Context = PreferencesContext & Pick<FrontendPreferences, "Fields">;
function Draft() {
  const [text, setText] = useState("");
  return (
    <input
      aria-label="Child draft"
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}
function fixture() {
  let current = createDefaultSettings();
  let context!: Context;
  let renderProvider = (_context: Context, _visible: boolean, fallback: ReactNode) => (
    <section aria-label="Builtin controls">{fallback}</section>
  );
  const services: PreferenceSurfaceServices = {
    useData: () => ({ settings: current, busy: false, error: null }),
    isCurrent: (value) => value === current,
    Provider: ({ context: next, visible, children: fallback }) => {
      context = next;
      return renderProvider(next, visible, fallback);
    },
  };
  const fields = [
    { id: "appearance.theme", label: "Theme", description: "Color mode", modified: false },
  ];
  const component = (visible = true, query = "") => (
    <PreferenceSurfaceView
      services={services}
      section="appearance"
      query={query}
      modifiedOnly={false}
      fields={fields}
      visible={visible}
    >
      <Draft />
    </PreferenceSurfaceView>
  );
  return {
    component,
    context: () => context,
    changeOwner: () => {
      current = { ...current, theme: "light" };
    },
    provider: (next: typeof renderProvider) => {
      renderProvider = next;
    },
    fields,
  };
}
describe("preference surface owner-independent presentation", () => {
  it("provides frozen field metadata and keeps preference objects out of the public context", () => {
    const owner = fixture();
    render(owner.component());
    expect(owner.context().snapshot.fields).toEqual(owner.fields);
    expect(Object.isFrozen(owner.context().snapshot)).toBe(true);
    expect(Object.isFrozen(owner.context().snapshot.fields[0])).toBe(true);
    expect(Object.keys(owner.context()).sort()).toEqual(["Fields", "snapshot", "validate"]);
    expect(owner.context().validate(true)).toBe(true);
  });
  it("invalidates old frames after search, hidden state, unmount or an owner change", () => {
    const owner = fixture();
    const view = render(owner.component());
    const old = owner.context();
    view.rerender(owner.component(true, "theme"));
    expect(old.validate(false)).toBe(false);
    expect(owner.context().validate(true)).toBe(true);
    view.rerender(owner.component(false, "theme"));
    expect(owner.context().validate(false)).toBe(true);
    expect(owner.context().validate(true)).toBe(false);
    owner.changeOwner();
    expect(owner.context().validate(false)).toBe(false);
    view.unmount();
    expect(owner.context().validate(false)).toBe(false);
  });
  it("lets the real provider relocate Fields without remounting host control drafts", () => {
    const owner = fixture();
    const view = render(owner.component());
    fireEvent.change(screen.getByRole("textbox", { name: "Child draft" }), {
      target: { value: "keep this" },
    });
    const input = screen.getByRole("textbox", { name: "Child draft" });
    owner.provider((context) => (
      <aside aria-label="Provider decoration">
        <context.Fields />
      </aside>
    ));
    view.rerender(owner.component());
    expect(screen.getByRole("complementary", { name: "Provider decoration" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Child draft" })).toBe(input);
    expect(input).toHaveProperty("value", "keep this");
  });
  it("does not replace provider presentation with builtin fields when the provider omits Fields", () => {
    const owner = fixture();
    owner.provider(() => <aside>Provider-specific content</aside>);
    render(owner.component());
    expect(screen.getByText("Provider-specific content")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Child draft" })).toBeNull();
  });
});
