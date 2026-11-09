import {
  Activity,
  Cloud,
  Code,
  Container,
  Database,
  Globe,
  KeyRound,
  Server,
  Shield,
  Terminal,
} from "lucide-react";
import type { OwnedHostDecoration } from "@/lib/plugins/hostList";

const ICONS = {
  activity: Activity,
  cloud: Cloud,
  code: Code,
  container: Container,
  database: Database,
  globe: Globe,
  key: KeyRound,
  server: Server,
  shield: Shield,
  terminal: Terminal,
};
export const NO_HOST_DECORATIONS: OwnedHostDecoration[] = [];
const tooltip = (item: OwnedHostDecoration) =>
  [item.pluginName, item.tooltip ?? item.description ?? item.badge].filter(Boolean).join(" · ");

export function HostDecorationIcon({ items }: { items: OwnedHostDecoration[] }) {
  const item = items.find((item) => item.icon);
  if (!item?.icon) return null;
  const Icon = ICONS[item.icon];
  return (
    <span
      className={`host-decoration__icon host-decoration--${item.tone}`}
      title={tooltip(item)}
      aria-label={tooltip(item)}
    >
      <Icon size={13} aria-hidden="true" />
    </span>
  );
}

export function HostDecorationBadges({ items }: { items: OwnedHostDecoration[] }) {
  const badges = items.filter((item) => item.badge),
    visible = badges.slice(0, 2),
    overflow = badges.slice(2);
  if (!badges.length) return null;
  return (
    <span className="host-decoration__badges">
      {visible.map((item) => (
        <span
          key={item.key}
          className={`host-decoration__badge host-decoration--${item.tone}`}
          title={tooltip(item)}
          aria-label={tooltip(item)}
        >
          {item.badge}
        </span>
      ))}
      {overflow.length > 0 ? (
        <span
          className="host-decoration__overflow"
          title={overflow.map(tooltip).join("\n")}
          aria-label={overflow.map(tooltip).join("; ")}
        >
          +{overflow.length}
        </span>
      ) : null}
    </span>
  );
}

export function HostDecorationDescription({ items }: { items: OwnedHostDecoration[] }) {
  const descriptions = items.filter((item) => item.description),
    item = descriptions[0];
  return item ? (
    <span
      className={`host-decoration__description host-decoration--${item.tone}`}
      title={descriptions.map(tooltip).join("\n")}
      aria-label={descriptions.map(tooltip).join("; ")}
    >
      {item.description}
    </span>
  ) : null;
}
