/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";
import type { UiButtonProps, UiIconButtonProps, UiFieldProps, UiSwitchProps } from "./controls.js";
import type { UiEmptyStateProps } from "./emptyState.js";
import type { UiSearchFieldProps } from "../search/field.js";

export interface UiSdk {
  readonly version: "0.1.0";
  /** The exact React instance used by the host renderer; never bundle a second one. */
  readonly react: typeof React;
  readonly components: Readonly<{
    Button: React.ComponentType<UiButtonProps>;
    IconButton: React.ComponentType<UiIconButtonProps>;
    Field: React.ComponentType<UiFieldProps>;
    Input: React.ComponentType<React.InputHTMLAttributes<HTMLInputElement>>;
    Textarea: React.ComponentType<React.TextareaHTMLAttributes<HTMLTextAreaElement>>;
    Switch: React.ComponentType<UiSwitchProps>;
    SearchField: React.ComponentType<UiSearchFieldProps>;
    EmptyState: React.ComponentType<UiEmptyStateProps>;
  }>;
}
