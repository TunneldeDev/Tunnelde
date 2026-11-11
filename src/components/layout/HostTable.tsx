import { useTranslation } from "react-i18next";
import { useLayoutEffect, useRef } from "react";
import { Menu } from "@/components/ui/overlay/Menu";
import { Columns3 } from "lucide-react";
import {
  defaultHostListPreferences,
  moveHostColumn,
  visibleHostColumns,
  type DisplayHostColumn,
  type HostListPreferences,
} from "@/lib/hosts/columns";
import { DataColumnHeader } from "@/components/ui/display/DataColumnHeader";
import { useSettings } from "@/store/settings";
import "./hostTable.css";

export function HostListViewMenu({ columns }: { columns: DisplayHostColumn[] }) {
  const { t } = useTranslation();
  const preferences = useSettings((state) => state.settings.hostList);
  const update = (patch: Partial<HostListPreferences>) =>
    void useSettings
      .getState()
      .update({ hostList: { ...useSettings.getState().settings.hostList, ...patch } });
  return (
    <Menu
      label={t("hostColumns.view")}
      trigger={<Columns3 size={15} />}
      items={[
        {
          label: t("hostColumns.tree"),
          checkable: "radio",
          checked: preferences.view === "tree",
          onSelect: () => update({ view: "tree" }),
        },
        {
          label: t("hostColumns.table"),
          checkable: "radio",
          checked: preferences.view === "table",
          onSelect: () => update({ view: "table" }),
        },
        ...columns.map((column, index) => ({
          label: column.label,
          description: column.source,
          separatorBefore: index === 0,
          disabled: column.key === "name",
          checkable: "checkbox" as const,
          checked: column.key === "name" || !preferences.hidden.includes(column.key),
          onSelect: () =>
            update({
              hidden: useSettings.getState().settings.hostList.hidden.includes(column.key)
                ? useSettings
                    .getState()
                    .settings.hostList.hidden.filter((key) => key !== column.key)
                : [...useSettings.getState().settings.hostList.hidden, column.key],
            }),
        })),
        {
          label: t("hostColumns.reset"),
          separatorBefore: true,
          onSelect: () =>
            void useSettings.getState().update({
              hostList: {
                ...defaultHostListPreferences(),
                view: useSettings.getState().settings.hostList.view,
              },
            }),
        },
      ]}
    />
  );
}

export function HostTableHeader({
  columns,
  allColumns,
}: {
  columns: DisplayHostColumn[];
  allColumns: DisplayHostColumn[];
}) {
  const header = useRef<HTMLDivElement>(null);
  const latestColumns = useRef(allColumns);
  useLayoutEffect(() => {
    latestColumns.current = allColumns;
  }, [allColumns]);
  const { t } = useTranslation();
  const preferences = useSettings((state) => state.settings.hostList);
  return (
    <div ref={header} className="host-table__header" role="row">
      {columns.map((column) => (
        <DataColumnHeader
          key={column.key}
          id={column.key}
          label={column.label}
          source={column.source}
          width={column.width}
          scope="hosts"
          sort={preferences.sort?.key === column.key ? preferences.sort.direction : undefined}
          moveHint={t("hostColumns.moveHint")}
          resizeLabel={t("hostColumns.resize", { name: column.label })}
          onSort={() => {
            const current = useSettings.getState().settings.hostList;
            void useSettings.getState().update({
              hostList: {
                ...current,
                sort:
                  current.sort?.key === column.key && current.sort.direction === "desc"
                    ? null
                    : {
                        key: column.key,
                        direction:
                          current.sort?.key === column.key && current.sort.direction === "asc"
                            ? "desc"
                            : "asc",
                      },
              },
            });
          }}
          onResize={(width, commit) => {
            const root = header.current?.closest<HTMLElement>(".host-table");
            root?.style.setProperty(
              "--host-columns",
              columns.map((item) => `${item.key === column.key ? width : item.width}px`).join(" "),
            );
            root?.style.setProperty(
              "--host-table-width",
              `${columns.reduce((sum, item) => sum + (item.key === column.key ? width : item.width), 0)}px`,
            );
            if (commit) {
              const current = useSettings.getState().settings.hostList;
              void useSettings
                .getState()
                .update({
                  hostList: {
                    ...current,
                    widths: { ...current.widths, [column.key]: width },
                  },
                })
                .then((ok) => {
                  if (ok || !root?.isConnected) return;
                  // React may not rewrite an unchanged style after an optimistic
                  // update rolls back; restore the current widths explicitly.
                  const saved = useSettings.getState().settings.hostList;
                  const widths = visibleHostColumns(latestColumns.current, saved).map(
                    (item) => item.width,
                  );
                  root.style.setProperty(
                    "--host-columns",
                    widths.map((value) => `${value}px`).join(" "),
                  );
                  root.style.setProperty(
                    "--host-table-width",
                    `${widths.reduce((sum, value) => sum + value, 0)}px`,
                  );
                });
            }
          }}
          onMove={(from, to) => {
            const current = useSettings.getState().settings.hostList;
            const order = [...new Set([...current.order, ...allColumns.map((item) => item.key)])];
            void useSettings
              .getState()
              .update({ hostList: { ...current, order: moveHostColumn(order, from, to) } });
          }}
        />
      ))}
    </div>
  );
}
