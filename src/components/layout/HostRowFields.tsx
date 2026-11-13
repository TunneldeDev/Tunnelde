import { useTranslation } from "react-i18next";
import type { DisplayHostColumn } from "@/lib/hosts/columns";

/** Tree metadata follows the same visible field order as the table. */
export function HostRowFields({
  hostId,
  columns,
}: {
  hostId: string;
  columns: readonly DisplayHostColumn[];
}) {
  const { t } = useTranslation();
  const fields = columns.flatMap((column) => {
    const cell = column.values.get(hostId);
    if (column.key === "name" || !cell || cell.value === "") return [];
    const value =
      typeof cell.value === "boolean"
        ? t(cell.value ? "hostFields.yes" : "hostFields.no")
        : String(cell.value);
    return [
      <span
        key={column.key}
        className="host-row__field"
        data-host-field={column.key}
        title={cell.tooltip ?? `${column.label}: ${value}`}
      >
        <span className="host-row__field-label">{column.label}: </span>
        {value}
      </span>,
    ];
  });
  return fields.length ? <span className="host-row__meta host-row__fields">{fields}</span> : null;
}
