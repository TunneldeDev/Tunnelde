import { Button } from "@/components/ui/form/Button";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { capturePanelDomState, restorePanelDomState } from "@/lib/panels/domState";
import { PanelViewStateScope } from "@/lib/panels/viewState";
import {
  transferablePanel,
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
  useLayoutEffect(() => {
    const element = root.current,
      views = windowViews();
    if (!element || !views) return;
    const restore = () => {
      if (restored.current || !element.getBoundingClientRect().width) return;
      if (record.dom) restorePanelDomState(element, record.dom);
      restored.current = true;
    };
    restore();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(restore);
    observer?.observe(element);
    const unregister = views.registerRoot(record.panelId, () => {
      if ((!restored.current || !element.getBoundingClientRect().width) && lastDom.current)
        return lastDom.current;
      return (lastDom.current = capturePanelDomState(element));
    });
    // Child layout effects have restored explicit React state. Hidden native
    // windows must not wait for rAF: WKWebView can suspend it before first show.
    element.getBoundingClientRect();
    views.rendered(record.key);
    return () => {
      unregister();
      observer?.disconnect();
    };
  }, [record.key, record.controller, record.dom, record.panelId]);
  const committed = useRef(false);
  useLayoutEffect(() => {
    if (record.staged || committed.current) return;
    committed.current = true;
    if (record.dom && root.current) restorePanelDomState(root.current, record.dom, { focus: true });
  }, [record, record.staged]);
  useLayoutEffect(() => {
    const element = root.current,
      views = windowViews();
    if (!element || !views || frozen || !record.lease) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkpoint = () => {
      if (element.getBoundingClientRect().width) lastDom.current = capturePanelDomState(element);
      clearTimeout(timer);
      timer = setTimeout(() => {
        void views.checkpoint(record.panelId).catch(() => {});
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
        <PanelViewStateScope controller={record.controller}>{children}</PanelViewStateScope>
      </div>
    </div>
  );
}

export function NativePanelView({ panelId, children }: { panelId: string; children: ReactNode }) {
  const { t } = useTranslation();
  const available = usePanelWindows((s) => s.available);
  const record = useWindowViews((s) => s.entries.get(panelId));
  if (!available || !transferablePanel(panelId)) return children;
  if (!record)
    return (
      <div className="native-panel-placeholder" role="status">
        <span>{t("panels.inOtherWindow")}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void windowViews()
              ?.client.focus(panelId)
              .catch(() => {});
          }}
        >
          {t("panels.focusWindow")}
        </Button>
      </div>
    );
  return (
    <OwnedNativeView key={record.key} record={record}>
      {children}
    </OwnedNativeView>
  );
}
