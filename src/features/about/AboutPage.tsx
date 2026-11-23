import { AboutPageView, type AboutLink } from "./AboutPageView";
import { presentError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import { toast } from "@/store/toasts";
import { useSettings } from "@/store/settings";
import { useViewState } from "@/lib/session/viewState";
const REPOSITORY = "https://github.com/TunneldeDev/Tunnelde";
const links: Record<AboutLink, string> = {
  source: REPOSITORY,
  license: `${REPOSITORY}/blob/main/LICENSE`,
  notices: `${REPOSITORY}/blob/main/THIRD_PARTY_NOTICES.md`,
};
function openLink(link: AboutLink) {
  void api.openExternal(links[link]).catch((error) => toast(presentError(error), "error"));
}
export function AboutPage({ embedded = false }: { embedded?: boolean }) {
  const info = useSettings((state) => state.info);
  return (
    <AboutPageView
      embedded={embedded}
      info={info}
      useViewState={useViewState}
      openLink={openLink}
    />
  );
}
