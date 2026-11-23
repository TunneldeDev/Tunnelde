import { lazy, Suspense, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { FontSettings } from "../FontSettings";
import { UpdateSourceUrl } from "../UpdateSettings";
import { HostListSettings } from "../HostListSettings";
import { PreferenceRow } from "./PreferenceRow";
import { CssEditor } from "./CssEditor";
import { PreferenceFieldsView, type PreferenceFieldsServices } from "./PreferenceFieldsView";
const TerminalPreview = lazy(() =>
  import("@/features/terminal/TerminalPreview").then((module) => ({
    default: module.TerminalPreview,
  })),
);
function Preview() {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<p className="settings-row__hint">{t("common.loading")}</p>}>
      <TerminalPreview />
    </Suspense>
  );
}
export const mainPreferenceFieldsServices: PreferenceFieldsServices = {
  renderFonts: () => <FontSettings />,
  renderTerminalPreview: () => <Preview />,
  renderUpdateSource: (props) => <UpdateSourceUrl {...props} />,
  renderHostList: () => <HostListSettings />,
  renderCss: (props) => <CssEditor {...props} />,
  renderRow: (props) => <PreferenceRow {...props} />,
};
export type PreferenceFieldsProps = Omit<ComponentProps<typeof PreferenceFieldsView>, "services">;
export function PreferenceFields(props: PreferenceFieldsProps) {
  return <PreferenceFieldsView {...props} services={mainPreferenceFieldsServices} />;
}
