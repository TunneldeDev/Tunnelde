import type { ComponentType } from "react";
import type { FrontendFilePreview } from "../../contracts/files/preview/provider";
import type { CheckProviderAccess } from "../../runtime/providers/access";
import type { FilePreviewContext } from "./context";

/** This stable wrapper fences even a component retained by another trusted module. */
export function createFilePreviewBody(
  Body: ComponentType,
  checkAccess: CheckProviderAccess,
  validateTarget: () => void,
) {
  return function FilePreviewBody() {
    checkAccess(false);
    validateTarget();
    return <Body />;
  };
}
export function guardFilePreviewProvider(
  context: FilePreviewContext,
  Body: ComponentType,
  checkAccess: CheckProviderAccess,
  writable: () => boolean,
): FrontendFilePreview {
  const check = (mutation: boolean) => {
    checkAccess(mutation);
    context.validate();
    if (mutation && !writable()) throw new Error("plugin.filePreview.permissionDenied");
  };
  return Object.freeze<FrontendFilePreview>({
    Body,
    snapshot: context.snapshot,
    readProviders(request) {
      check(false);
      return context.readProviders(request);
    },
    close() {
      check(true);
      return context.close();
    },
    retry() {
      check(true);
      return context.retry();
    },
    dock() {
      check(true);
      return context.dock();
    },
    undock() {
      check(true);
      return context.undock();
    },
    selectProvider(providerId) {
      check(true);
      return context.selectProvider(providerId);
    },
  });
}
