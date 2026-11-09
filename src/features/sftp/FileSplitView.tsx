import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { SplitPanels } from "@/components/ui/layout/SplitPanels";

function readRatio(key: string) {
  try {
    const stored = Number(localStorage.getItem(key) ?? 50);
    return Number.isFinite(stored) ? Math.max(20, Math.min(80, stored)) : 50;
  } catch {
    return 50;
  }
}

export function FileSplitView({
  storageKey,
  left,
  right,
}: {
  storageKey: string;
  left: ReactNode;
  right: ReactNode;
}) {
  return <StoredFileSplit key={storageKey} storageKey={storageKey} left={left} right={right} />;
}

function StoredFileSplit({
  storageKey,
  left,
  right,
}: {
  storageKey: string;
  left: ReactNode;
  right: ReactNode;
}) {
  const { t } = useTranslation();
  const [percent, setPercent] = useState(() => readRatio(storageKey));
  return (
    <SplitPanels
      mode="grid"
      className="sftp-panes sftp-panes--resizable"
      separatorClassName="sftp-splitter"
      separatorSize={6}
      ratio={percent / 100}
      minRatio={0.2}
      maxRatio={0.8}
      label={t("sftp.resizePanels")}
      first={left}
      second={right}
      onRatioChange={(ratio) => {
        const next = Number((ratio * 100).toFixed(8));
        setPercent(next);
        try {
          localStorage.setItem(storageKey, String(next));
        } catch {
          /* Optional preference. */
        }
      }}
    />
  );
}
