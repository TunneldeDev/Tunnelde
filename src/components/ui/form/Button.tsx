// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { cn } from "@/lib/format";

type Variant = "primary" | "secondary" | "ghost" | "ghost-danger" | "danger";
type Size = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export function Button({
  className,
  variant = "secondary",
  size = "md",
  leading,
  trailing,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn("td-btn", `td-btn--${variant}`, `td-btn--${size}`, className)}
      {...rest}
    >
      {leading ? <span className="td-btn__icon">{leading}</span> : null}
      {children ? <span className="td-btn__label">{children}</span> : null}
      {trailing ? <span className="td-btn__icon">{trailing}</span> : null}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  danger?: boolean;
  size?: "sm" | "md";
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  label,
  active = false,
  danger = false,
  size = "md",
  className,
  children,
  ref,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      ref={ref}
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={cn(
        "td-icon-btn",
        `td-icon-btn--${size}`,
        active && "is-active",
        danger && "is-danger",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
