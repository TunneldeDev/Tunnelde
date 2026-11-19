import { createContext, useContext, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "../overlay/Tooltip";

export type HelpPresentation = "inline" | "tooltip";
const HelpContext = createContext<HelpPresentation>("inline");
export const HelpPresentationProvider = HelpContext.Provider;
export function useHelpPresentation(override?: HelpPresentation) {
  const inherited = useContext(HelpContext);
  return override ?? inherited;
}

/** Put next to a label, never inside its <label> (which would toggle the input). */
export function HelpHint({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Tooltip content={children}>
      {(descriptionId) => (
        <button
          type="button"
          className="td-help-hint"
          aria-label={t("common.helpFor", { label })}
          aria-describedby={descriptionId}
        >
          <CircleHelp size={14} aria-hidden="true" />
        </button>
      )}
    </Tooltip>
  );
}
