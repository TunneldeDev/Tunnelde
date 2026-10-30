// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { ReactNode } from "react";

import { cn } from "@/lib/text/format";

export type DotTone = "idle" | "ok" | "warn" | "error" | "accent";

export function StatusDot({ tone = "idle", className }: { tone?: DotTone; className?: string }) {
  return <span className={cn("td-dot", `td-dot--${tone}`, className)} aria-hidden="true" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="td-kbd">{children}</kbd>;
}

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <div className="td-empty">
      {icon ? <div className="td-empty__icon">{icon}</div> : null}
      <p className="td-empty__title">{title}</p>
      {body ? <p className="td-empty__body">{body}</p> : null}
      {action ? <div className="td-empty__action">{action}</div> : null}
    </div>
  );
}
