import type { ComponentProps } from "react";
import { Disclosure } from "@/components/ui/layout/Disclosure";
import { usePanelViewState } from "@/lib/panels/viewState";

export function ConnectionDisclosure({
  stateKey,
  ...props
}: Omit<ComponentProps<typeof Disclosure>, "open" | "onToggle"> & { stateKey: string }) {
  const [open, setOpen] = usePanelViewState(
    stateKey,
    false,
    (value): value is boolean => typeof value === "boolean",
  );
  return (
    <Disclosure {...props} open={open} onToggle={(event) => setOpen(event.currentTarget.open)} />
  );
}
