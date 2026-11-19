import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelRight, SquareArrowOutUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SidebarPortal } from "@/components/layout/SidebarDock";
import { PanelHeader } from "@/components/layout/WorkbenchPanel";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Button, IconButton } from "@/components/ui/form/Button";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import type { PreviewPresentation } from "@/store/filePreview";
import "./previewPanel.css";

/** Presentation moves the same host-owned renderer, including media and its ticket. */
export function PreviewFrame({
  title,
  presentation,
  children,
  actions,
  onClose,
  onDock,
  onUndock,
}: {
  title: string;
  presentation: PreviewPresentation;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  onDock: () => void;
  onUndock: () => void;
}) {
  const { t } = useTranslation();
  const [surface] = useState(createPersistentSurface);
  const Body = surface.Mount;
  return (
    <>
      {presentation === "quickLook" ? (
        <Dialog
          open
          title={title}
          closeLabel={t("common.close")}
          onClose={onClose}
          width={820}
          className="file-preview"
          footer={
            <>
              <Button variant="secondary" onClick={onDock} leading={<PanelRight size={14} />}>
                {t("preview.dock")}
              </Button>
              {actions}
            </>
          }
        >
          <Body />
        </Dialog>
      ) : (
        <SidebarPortal view="filePreview">
          <section className="sidebar file-preview-panel" aria-label={title}>
            <PanelHeader view="filePreview" managed>
              <div className="sidebar__actions">
                {actions}
                <IconButton label={t("preview.undock")} onClick={onUndock}>
                  <SquareArrowOutUpRight size={14} />
                </IconButton>
              </div>
            </PanelHeader>
            <div className="file-preview-panel__body">
              <Body />
            </div>
          </section>
        </SidebarPortal>
      )}
      {createPortal(children, surface.container)}
    </>
  );
}
