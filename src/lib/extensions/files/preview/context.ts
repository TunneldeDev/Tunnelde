import type { FrontendFilePreview } from "../../contracts/files/preview/provider";

export type FilePreviewContext = Omit<FrontendFilePreview, "Body"> & {
  /** Valid only while this exact frame is committed and its target is still current. */
  validate: () => void;
  validateTarget: () => void;
};
