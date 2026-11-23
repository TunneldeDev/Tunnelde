import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError, type DiagnosticEvent } from "@/lib/diagnostics";

interface Props {
  children: ReactNode;
  domain: string;
  operation: string;
  fallback: (event: DiagnosticEvent | null, retry: () => void) => ReactNode;
  failed?: (error: unknown) => void;
  resetKey?: unknown;
  propagate?: boolean;
}

/** Local recovery for owned UI. A staged caller can instead reject the offer. */
export class PanelViewBoundary extends Component<
  Props,
  { failed: boolean; event: DiagnosticEvent | null }
> {
  override state = { failed: false, event: null };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    if (this.props.propagate) throw error;
    const event = reportError(this.props.domain, this.props.operation, error, "error", {
      componentStack: info.componentStack ?? undefined,
    });
    this.setState({ event });
    this.props.failed?.(error);
  }
  override componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.retry();
  }
  retry = () => this.setState({ failed: false, event: null });

  override render() {
    return this.state.failed
      ? this.props.fallback(this.state.event, this.retry)
      : this.props.children;
  }
}
