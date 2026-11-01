import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Menu } from "@/components/ui/overlay/Menu";
import type { FileViewPreferences } from "@/lib/files/view";

interface FileViewMenuProps {
  view: FileViewPreferences;
  onChange: (change: Partial<FileViewPreferences>) => void;
  onReset: () => void;
}

export function FileViewMenu({ view, onChange, onReset }: FileViewMenuProps) {
  const { t } = useTranslation();
  const check = (selected: boolean) => (
    <Check size={13} visibility={selected ? "visible" : "hidden"} />
  );

  return (
    <Menu
      label={t("sftp.viewOptions")}
      items={[
        {
          label: t("sftp.showHidden"),
          icon: check(view.filesShowHidden),
          onSelect: () => onChange({ filesShowHidden: !view.filesShowHidden }),
        },
        {
          label: t("sftp.foldersFirst"),
          icon: check(view.filesFoldersFirst),
          onSelect: () => onChange({ filesFoldersFirst: !view.filesFoldersFirst }),
        },
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
          icon: check(view.filesSortBy === sort),
          onSelect: () => onChange({ filesSortBy: sort }),
        })),
        ...(["asc", "desc"] as const).map((direction) => ({
          separatorBefore: direction === "asc",
          label: t(direction === "asc" ? "sftp.sortAscending" : "sftp.sortDescending"),
          icon: check(view.filesSortDirection === direction),
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
          icon: check((view.filesGroupBy ?? "none") === group),
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
