import { Funnel, Search, X } from "lucide-react";
import { useImperativeHandle, useRef, type InputHTMLAttributes, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Menu, type MenuAction } from "@/components/ui/overlay/Menu";
import { IconButton } from "./Button";
import {
  clearSearchFilters,
  parseSearchQuery,
  searchFilterPrefix,
  searchText,
  toggleSearchFilter,
} from "@/lib/search/query";
import { cn } from "@/lib/text/format";
import "./searchField.css";

export interface SearchPreset {
  key: string;
  value: string;
  label: string;
  exclusive?: boolean;
  separatorBefore?: boolean;
}

export function SearchFilterMenu({
  query,
  onChange,
  presets = [],
  items,
  focusInput,
  label,
  disabled,
  filterKeys = [],
}: {
  query: string;
  onChange: (value: string) => void;
  presets?: readonly SearchPreset[];
  items?: MenuAction[];
  focusInput?: () => void;
  label?: string;
  disabled?: boolean;
  filterKeys?: readonly string[];
}) {
  const { t } = useTranslation();
  const keys = [
    ...new Set(
      [...filterKeys, ...presets.map((preset) => preset.key)].map((key) =>
        key.replace(/^@/, "").toLowerCase(),
      ),
    ),
  ];
  const parsed = parseSearchQuery(query, keys);
  const change = (next: string) => {
    onChange(next);
    queueMicrotask(() => focusInput?.());
  };
  const actions: MenuAction[] = items ?? [
    ...presets.map((preset) => ({
      label: preset.label,
      description: `${searchFilterPrefix(preset.key)}${/[\s,"\\]/.test(preset.value) ? JSON.stringify(preset.value) : preset.value}`,
      checked: preset.value
        ? parsed.filters.some(
            (filter) =>
              !filter.exclude &&
              filter.key === preset.key.replace(/^@/, "").toLowerCase() &&
              filter.values.includes(searchText(preset.value)),
          )
        : undefined,
      checkable: preset.value ? ("checkbox" as const) : undefined,
      separatorBefore: preset.separatorBefore,
      onSelect: () => change(toggleSearchFilter(query, preset.key, preset.value, preset.exclusive)),
    })),
    {
      label: t("searchUi.clearFilters"),
      separatorBefore: true,
      disabled: !parsed.filters.length,
      onSelect: () => change(clearSearchFilters(query, keys)),
    },
  ];
  return (
    <Menu
      disabled={disabled}
      label={label ?? t("searchUi.filters")}
      trigger={<Funnel size={14} aria-hidden="true" />}
      className={cn(
        "td-search__filter",
        (items?.some((item) => item.checked) ?? parsed.filters.length > 0) && "is-active",
      )}
      menuClassName="td-search__presets"
      items={actions}
    />
  );
}

interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "value" | "size"
> {
  value: string;
  onChange: (value: string) => void;
  presets?: readonly SearchPreset[];
  filterItems?: MenuAction[];
  inputRef?: Ref<HTMLInputElement>;
  inputClassName?: string;
  filterLabel?: string;
  filterKeys?: readonly string[];
}

/** One focus ring around icon, input and presets; native input semantics stay intact. */
export function SearchField({
  value,
  onChange,
  presets,
  filterItems,
  filterLabel,
  filterKeys,
  className,
  inputClassName,
  inputRef,
  ...props
}: SearchFieldProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(inputRef, () => input.current!);
  return (
    <div className={cn("td-search", className)} role="search">
      <Search size={14} aria-hidden="true" />
      <input
        {...props}
        className={cn("td-input", inputClassName)}
        type={props.type ?? "text"}
        ref={input}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <IconButton
          size="sm"
          label={t("searchUi.clear")}
          disabled={props.disabled || props.readOnly}
          onClick={() => {
            onChange("");
            input.current?.focus();
          }}
        >
          <X size={13} />
        </IconButton>
      )}
      <SearchFilterMenu
        disabled={props.disabled || props.readOnly}
        filterKeys={filterKeys}
        label={filterLabel}
        query={value}
        onChange={onChange}
        presets={presets}
        items={filterItems}
        focusInput={() => input.current?.focus()}
      />
    </div>
  );
}
