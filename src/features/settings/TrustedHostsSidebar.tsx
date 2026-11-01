import { KnownHostsList } from "@/features/settings/KnownHostsList";

/** The same trust-management actions are available in the compact side view. */
export function TrustedHostsSidebar({ active }: { active: boolean }) {
  return <KnownHostsList active={active} variant="sidebar" />;
}
