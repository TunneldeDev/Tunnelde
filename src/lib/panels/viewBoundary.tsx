import { Component, type ReactNode } from "react";

/** A failed staged renderer must roll back its offer, not unmount a document's
 * other panels or allow an error fallback to count as a rendered destination. */
export class PanelViewBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; failed: (error: unknown) => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.failed(error);
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
