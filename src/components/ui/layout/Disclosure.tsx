import type { DetailsHTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/text/format";
import "./disclosure.css";

interface DisclosureProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "children"> {
  heading: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
}

/** Native disclosure keeps keyboard and no-JavaScript expand/collapse behavior. */
export function Disclosure({ heading, summary, children, className, ...rest }: DisclosureProps) {
  return (
    <details {...rest} className={cn("td-disclosure", className)}>
      <summary className="td-disclosure__summary">
        <ChevronRight className="td-disclosure__chevron" size={14} aria-hidden="true" />
        <span className="td-disclosure__heading">{heading}</span>
        {summary ? <span className="td-disclosure__status">{summary}</span> : null}
      </summary>
      <div className="td-disclosure__body">{children}</div>
    </details>
  );
}
