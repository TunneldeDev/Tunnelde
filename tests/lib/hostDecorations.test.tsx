import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { indexHostDecorations, type HostDecorationSet } from "@/lib/plugins/hostList";
import {
  HostDecorationBadges,
  HostDecorationDescription,
  HostDecorationIcon,
} from "@/components/layout/HostDecorations";

const set = (pluginId: string, priority: number, hostId = "host"): HostDecorationSet => ({
  id: "health",
  pluginId,
  pluginName: pluginId,
  priority,
  decorations: [
    {
      hostId,
      badge: pluginId,
      description: pluginId + " description",
      tooltip: null,
      icon: "server",
      tone: "success",
    },
  ],
});
it("indexes by host and combines multiple owners in priority and deterministic ID order", () => {
  const source = [set("b", 0), set("z", 10), set("a", 0), set("other", 99, "other-host")];
  const index = indexHostDecorations(source);
  expect(index.get("host")!.map((item) => item.pluginName)).toEqual(["z", "a", "b"]);
  expect(source.map((item) => item.pluginId)).toEqual(["b", "z", "a", "other"]);
  expect(index.get("missing")).toBeUndefined();
  expect(new Set(index.get("host")!.map((item) => item.key)).size).toBe(3);
});
it("bounds visible badges, preserves overflow provenance and renders text without HTML interpretation", () => {
  const input = [set("<img src=x>", 10), set("B", 1), set("C", 0)];
  const items = indexHostDecorations(input).get("host")!;
  const { container } = render(
    <>
      <HostDecorationBadges items={items} />
      <HostDecorationIcon items={items} />
      <HostDecorationDescription items={items} />
    </>,
  );
  expect(container.querySelectorAll(".host-decoration__badge")).toHaveLength(2);
  expect(screen.getByText("+1").getAttribute("title")).toContain("C");
  expect(screen.getByText("<img src=x>")).toBeDefined();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".host-decoration__description")!.textContent).toBe(
    "<img src=x> description",
  );
  expect(container.querySelector(".host-decoration__icon")!.getAttribute("aria-label")).toContain(
    "<img src=x>",
  );
});
it("renders no markup when a host has no contributions", () => {
  const { container } = render(
    <>
      <HostDecorationBadges items={[]} />
      <HostDecorationIcon items={[]} />
      <HostDecorationDescription items={[]} />
    </>,
  );
  expect(container.innerHTML).toBe("");
});
