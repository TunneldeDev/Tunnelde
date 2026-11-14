import type { ReactNode } from "react";
import { SearchField, type SearchFieldProps } from "../form/SearchField";
import { cn } from "@/lib/text/format";
import "./searchToolbar.css";

export interface SearchToolbarProps extends SearchFieldProps {
  as?: "div" | "header";
  searchClassName?: string;
  status?: ReactNode;
  actions?: ReactNode;
}

/** Search and trailing controls wrap as groups when a docked panel becomes narrow. */
export function SearchToolbar({
  as: Container = "div",
  className,
  searchClassName,
  status,
  actions,
  ...search
}: SearchToolbarProps) {
  return (
    <Container className={cn("td-search-toolbar", className)}>
      <SearchField {...search} className={cn("td-search-toolbar__field", searchClassName)} />
      {status != null || actions != null ? (
        <div className="td-search-toolbar__controls">
          {status != null ? <span className="td-search-toolbar__status">{status}</span> : null}
          {actions}
        </div>
      ) : null}
    </Container>
  );
}
