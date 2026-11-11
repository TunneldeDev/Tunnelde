/** Public experimental UI SDK 0.1.0 contract. */
import type * as React from "react";

/** Movable host-owned surfaces. Their contents stay mounted when a provider changes. */
export interface FrontendWorkbenchSlots {
  Workspace: React.ComponentType;
  Navigation: React.ComponentType;
  Inspector: React.ComponentType;
  StatusBar: React.ComponentType;
}
