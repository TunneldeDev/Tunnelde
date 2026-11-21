import { createRoot } from "react-dom/client";
import { EditorConflictDialog } from "./EditorConflictDialog";
/** Conflict reads and writes remain in the authoritative document. */
export function reviewEditorWindow(tabId: string): Promise<void> {
  return new Promise((resolve) => {
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    const close = () => {
      root.unmount();
      element.remove();
      resolve();
    };
    root.render(<EditorConflictDialog tabId={tabId} onClose={close} />);
  });
}
