import { useTranslation } from "react-i18next";

import { Menu } from "@/components/ui/overlay/Menu";
import { FILE_COLUMNS, type FileViewPreferences } from "@/lib/files/view";

interface FileViewMenuProps {
  view: FileViewPreferences;
  onChange: (change: Partial<FileViewPreferences>) => void;
  onReset: () => void;
}

export function FileViewMenu({ view, onChange, onReset }: FileViewMenuProps) {
  const { t } = useTranslation();

  return (
    <Menu
      label={t("sftp.viewOptions")}
      items={[
        ...(["details", "columns"] as const).map((layout) => ({
          label: t(layout === "details" ? "sftp.detailsView" : "sftp.columnsView"),
          checked: (view.filesLayout ?? "details") === layout,
          checkable: "radio" as const,
          onSelect: () => onChange({ filesLayout: layout }),
        })),
        {
          separatorBefore: true,
          label: t("sftp.showHidden"),
          checked: view.filesShowHidden,
          checkable: "checkbox" as const,
          onSelect: () => onChange({ filesShowHidden: !view.filesShowHidden }),
        },
        {
          label: t("sftp.foldersFirst"),
          checked: view.filesFoldersFirst,
          checkable: "checkbox" as const,
          onSelect: () => onChange({ filesFoldersFirst: !view.filesFoldersFirst }),
        },
        ...FILE_COLUMNS.filter((column) => column !== "name").map((column, index) => ({
          separatorBefore: index === 0,
          label: `${t("sftp.showColumn")}: ${t(column === "type" ? "sftp.sortType" : column === "size" ? "sftp.sortSize" : "sftp.sortModified")}`,
          checked: (view.filesColumns ?? FILE_COLUMNS).includes(column),
          checkable: "checkbox" as const,
          onSelect: () => {
            const columns = view.filesColumns ?? [...FILE_COLUMNS];
            onChange({
              filesColumns: columns.includes(column)
                ? columns.filter((item) => item !== column)
                : [...columns, column],
            });
          },
        })),
        ...(["name", "type", "size", "modified"] as const).map((sort) => ({
          separatorBefore: sort === "name",
          label: t(
            sort === "name"
              ? "sftp.sortName"
              : sort === "type"
                ? "sftp.sortType"
                : sort === "size"
                  ? "sftp.sortSize"
                  : "sftp.sortModified",
          ),
          checked: view.filesSortBy === sort,
          checkable: "radio" as const,
          onSelect: () => onChange({ filesSortBy: sort }),
        })),
        ...(["asc", "desc"] as const).map((direction) => ({
          separatorBefore: direction === "asc",
          label: t(direction === "asc" ? "sftp.sortAscending" : "sftp.sortDescending"),
          checked: view.filesSortDirection === direction,
          checkable: "radio" as const,
          onSelect: () => onChange({ filesSortDirection: direction }),
        })),
        ...(["none", "type", "modified", "initial"] as const).map((group) => ({
          separatorBefore: group === "none",
          label: t(
            group === "none"
              ? "sftp.groupNone"
              : group === "type"
                ? "sftp.groupType"
                : group === "modified"
                  ? "sftp.groupModified"
                  : "sftp.groupInitial",
          ),
          checked: (view.filesGroupBy ?? "none") === group,
          checkable: "radio" as const,
          onSelect: () => onChange({ filesGroupBy: group }),
        })),
        {
          separatorBefore: true,
          label: t("sftp.resetView"),
          onSelect: onReset,
        },
      ]}
    />
  );
}
