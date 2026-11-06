import type { ReactNode } from "react";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  description?: string;
  checked?: boolean;
  checkable?: "radio" | "checkbox";
  onSelect: () => void;
}
