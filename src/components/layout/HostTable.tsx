import { useTranslation } from "react-i18next";
import { useLayoutEffect, useRef } from "react";
import { Menu } from "@/components/ui/overlay/Menu";
import { Columns3 } from "lucide-react";
import { hostTableLayout, visibleHostColumns, type DisplayHostColumn } from "@/lib/hosts/columns";
import { DataColumnHeader } from "@/components/ui/display/DataColumnHeader";
import { useHostPanel } from "@/features/hosts/panel/context";
import "./hostTable.css";

export function HostListViewMenu({ columns }: { columns: DisplayHostColumn[] }) {
  const { t } = useTranslation();
  const { data, run } = useHostPanel();
  const preferences = data.preferences;
  return (
    <Menu
      label={t("hostColumns.view")}
      trigger={<Columns3 size={15} />}
      items={[
        {
          label: t("hostColumns.tree"),
          checkable: "radio",
          checked: preferences.view === "tree",
          onSelect: () => void run({ operation: "view", view: "tree" }),
        },
        {
          label: t("hostColumns.table"),
          checkable: "radio",
          checked: preferences.view === "table",
          onSelect: () => void run({ operation: "view", view: "table" }),
        },
        ...columns.map((column, index) => ({
          label: column.label,
          description: column.source,
          separatorBefore: index === 0,
          disabled: column.key === "name",
          checkable: "checkbox" as const,
          checked: column.key === "name" || !preferences.hidden.includes(column.key),
          onSelect: () => void run({ operation: "column", key: column.key, command: "toggle" }),
        })),
        {
          label: t("hostColumns.reset"),
          separatorBefore: true,
          onSelect: () => void run({ operation: "resetColumns" }),
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
  const { data, run } = useHostPanel();
  const preferences = data.preferences;
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
            void run({ operation: "column", key: column.key, command: "sort" });
          }}
          onResize={(width, commit) => {
            const root = header.current?.closest<HTMLElement>(".host-table");
            const layout = hostTableLayout(
              columns.map((item) => (item.key === column.key ? { ...item, width } : item)),
              { ...preferences.widths, [column.key]: width },
            );
            root?.style.setProperty("--host-columns", layout.columns);
            root?.style.setProperty("--host-table-width", `${layout.minimum}px`);
            if (commit) {
              void run({ operation: "resizeColumn", key: column.key, width }).then((ok) => {
                if (ok || !root?.isConnected) return;
                // React may not rewrite an unchanged style after an optimistic
                // update rolls back; restore the current widths explicitly.
                const saved = data.preferences;
                const layout = hostTableLayout(
                  visibleHostColumns(latestColumns.current, saved),
                  saved.widths,
                );
                root.style.setProperty("--host-columns", layout.columns);
                root.style.setProperty("--host-table-width", `${layout.minimum}px`);
              });
            }
          }}
          onResizeCancel={() => {
            const root = header.current?.closest<HTMLElement>(".host-table");
            const layout = hostTableLayout(columns, preferences.widths);
            root?.style.setProperty("--host-columns", layout.columns);
            root?.style.setProperty("--host-table-width", `${layout.minimum}px`);
          }}
          onMove={(from, to) => {
            void run({ operation: "moveColumn", from, to });
          }}
        />
      ))}
    </div>
  );
}
