import { bindingsFor, displayShortcut } from "@/lib/keyboard/registry";
import { cn } from "@/lib/text/format";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useFileIconResolver } from "@/lib/files/icons";
import type { QuickAccessController } from "../runtime/useController";
export function QuickAccessEntries({
  manager,
  id,
}: {
  manager: QuickAccessController;
  id: string;
}) {
  const resolveFileIcon = useFileIconResolver();
  const { visible, offset, index: current, setIndex, runNative, settings, definitions } = manager;
  return (
    <>
      {visible.map((command, pageIndex) => {
        const position = offset + pageIndex;
        return (
          <button
            key={command.id}
            id={`${id}-${position}`}
            data-result-index={position}
            tabIndex={-1}
            type="button"
            role="option"
            aria-selected={position === current}
            className={cn("td-palette__item", position === current && "is-active")}
            onMouseEnter={() => setIndex(position)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runNative(command)}
          >
            {command.fileName ? <FileTypeIcon icon={resolveFileIcon(command.fileName)} /> : null}
            <span className="td-palette__label">
              <span>{command.title}</span>
              {command.detail && <small title={command.detail}>{command.detail}</small>}
            </span>
            {bindingsFor(command.id, settings.keyboardShortcuts, undefined, definitions)[0] && (
              <kbd aria-hidden="true" className="td-palette__shortcut">
                {displayShortcut(
                  bindingsFor(command.id, settings.keyboardShortcuts, undefined, definitions)[0]!,
                )}
              </kbd>
            )}
          </button>
        );
      })}
    </>
  );
}
