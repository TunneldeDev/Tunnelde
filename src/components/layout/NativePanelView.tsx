import { DiagnosticNotice } from "@/components/ui/overlay/DiagnosticNotice";
import { createDiagnosticSampler, reportError } from "@/lib/diagnostics";
import { PanelViewBoundary } from "@/lib/panels/viewBoundary";
import { PanelInteractionScope } from "@/lib/panels/interaction";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { capturePanelDomState, restorePanelDomState } from "@/lib/panels/domState";
import { PanelViewStateScope } from "@/lib/panels/viewState";
import {
  renderablePanel,
  useWindowViews,
  windowViews,
  type WindowViewRecord,
} from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";

function OwnedNativeView({ record, children }: { record: WindowViewRecord; children: ReactNode }) {
  const { t } = useTranslation();
  const interrupted = usePanelWindows(
    (s) => s.snapshot.interruptions?.some((item) => item.panelId === record.panelId) ?? false,
  );
  const root = useRef<HTMLDivElement>(null);
  const frozen = usePanelWindows(
    (s) =>
      interrupted ||
      record.staged ||
      !!record.moving ||
      s.snapshot.transfers.some(({ offer }) => offer.lease.panelId === record.panelId),
  );
  const restored = useRef(false);
  const lastDom = useRef(record.dom);
  const committed = useRef(false);
  const focusRestored = useRef(false);
  const focusWhenReady = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const element = root.current,
      views = windowViews();
    if (!element || !views) return;
    const restore = () => {
      if (restored.current || !element.getBoundingClientRect().width) return;
      if (record.dom) restorePanelDomState(element, record.dom);
      restored.current = true;
    };
    const lifetime = new AbortController();
    let ready = false;
    const focus = () => {
      if (!ready || !committed.current || focusRestored.current || lifetime.signal.aborted) return;
      if (record.dom) restorePanelDomState(element, record.dom, { focus: true });
      focusRestored.current = true;
    };
    focusWhenReady.current = focus;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
    const unregister = views.registerRoot(record.panelId, () => {
      if ((!restored.current || !element.getBoundingClientRect().width) && lastDom.current)
        return lastDom.current;
      return (lastDom.current = capturePanelDomState(element));
    });
    // Child layout effects have restored explicit React state. Hidden native
    // windows must not wait for rAF: WKWebView can suspend it before first show.
    const rendered = () => {
      if (lifetime.signal.aborted) return;
      ready = true;
      restore();
      focus();
      observer?.observe(element);
      element.getBoundingClientRect();
      views.rendered(record.key);
    };
    const failed = (error: unknown) => {
      if (!lifetime.signal.aborted) {
        reportError("panels", "waitForView", error);
        views.renderFailed(record.key, error);
      }
    };
    if (record.controller.hasReadiness()) {
      void record.controller.waitReady(lifetime.signal).then(rendered).catch(failed);
    } else {
      rendered();
    }
    return () => {
      lifetime.abort();
      if (focusWhenReady.current === focus) focusWhenReady.current = null;
      unregister();
      observer?.disconnect();
    };
  }, [record.key, record.controller, record.dom, record.panelId]);
  useLayoutEffect(() => {
    if (record.staged) return;
    committed.current = true;
    focusWhenReady.current?.();
  }, [record, record.staged]);
  useLayoutEffect(() => {
    // Freezing via inert may blur the source. A failed/cancelled handoff must
    // return its original caret after React has removed inert, not focus a shell.
    if (!frozen && !record.moving && record.frozenDom && root.current)
      restorePanelDomState(root.current, record.frozenDom, { focus: true });
  }, [frozen, record.moving, record.frozenDom]);
  useLayoutEffect(() => {
    const element = root.current,
      views = windowViews();
    if (!element || !views || frozen || !record.lease) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const diagnostics = createDiagnosticSampler("panels", "checkpoint");
    const checkpoint = () => {
      record.controller.invalidate();
      if (element.getBoundingClientRect().width) lastDom.current = capturePanelDomState(element);
      clearTimeout(timer);
      timer = setTimeout(() => {
        void views.checkpoint(record.panelId).then(diagnostics.recovered, diagnostics.failed);
      }, 100);
    };
    const events = ["scroll", "input", "change", "toggle", "focusin", "keyup"];
    for (const event of events) element.addEventListener(event, checkpoint, true);
    const unlisten = record.controller.subscribe(checkpoint);
    checkpoint();
    return () => {
      unlisten();
      clearTimeout(timer);
      for (const event of events) element.removeEventListener(event, checkpoint, true);
    };
  }, [frozen, record.panelId, record.lease, record.controller]);
  return (
    <div className="native-panel-frame">
      {interrupted ? (
        <p className="native-panel-interruption" role="alert">
          {t("panels.actionInterrupted")}
        </p>
      ) : null}
      <div
        ref={root}
        className="native-panel-view"
        data-panel-staged={record.staged || undefined}
        inert={frozen || undefined}
        aria-busy={frozen || undefined}
      >
        <PanelViewBoundary
          domain="panels"
          operation="render"
          fallback={(event) => <DiagnosticNotice event={event} />}
          failed={(error) => windowViews()?.renderFailed(record.key, error)}
        >
          <PanelViewStateScope controller={record.controller}>
            <PanelInteractionScope
              value={{ client: windowViews()?.client, lease: record.lease, staged: record.staged }}
            >
              {children}
            </PanelInteractionScope>
          </PanelViewStateScope>
        </PanelViewBoundary>
      </div>
    </div>
  );
}

export function NativePanelView({ panelId, children }: { panelId: string; children: ReactNode }) {
  const available = usePanelWindows((s) => s.available);
  const record = useWindowViews((s) => s.entries.get(panelId));
  if (!available || !renderablePanel(panelId)) return children;
  // A moved panel has no body in the source window. Rendering a placeholder
  // would leave a stale surface that looks like a second, disabled panel.
  if (!record) return null;
  return (
    <OwnedNativeView key={record.key} record={record}>
      {children}
    </OwnedNativeView>
  );
}
