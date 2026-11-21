import type { ComponentProps } from "react";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";
import { RegionColors } from "../RegionColors";
import { FileIconThemeSetting } from "../FileIconThemeSetting";
import { PreferenceRowView } from "./PreferenceRowView";
export type PreferenceRowProps = Omit<ComponentProps<typeof PreferenceRowView>, "services">;
/** Main-document owner composition; native renderers supply their own effects. */
export function PreferenceRow(props: PreferenceRowProps) {
  const update = useSettings((s) => s.update);
  const updatesBusy = useUpdates(
    (s) => s.busy || s.state?.phase === "downloading" || s.state?.phase === "ready",
  );
  return (
    <PreferenceRowView
      {...props}
      services={{
        update,
        updatesBusy,
        renderColors: (settings) => <RegionColors settings={settings} />,
        renderFileIcons: (props) => <FileIconThemeSetting {...props} />,
      }}
    />
  );
}
