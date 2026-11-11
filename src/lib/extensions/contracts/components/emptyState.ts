/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";

export interface UiEmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}
