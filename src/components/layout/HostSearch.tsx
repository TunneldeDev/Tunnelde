import { Search, Tag, X } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { SearchFilterMenu } from "@/components/ui/form/SearchField";
import { completeHostTag, parseHostQuery, tagCompletion } from "@/lib/hosts/query";

export function HostSearch({
  query,
  tags,
  onChange,
}: {
  query: string;
  tags: string[];
  onChange: (query: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const completion = tagCompletion(query);
  const options = useMemo(() => {
    const completion = tagCompletion(query);
    const selected = parseHostQuery(completion ? query.slice(0, completion.start) : query).tags;
    const needle = (completion?.value ?? "").toLocaleLowerCase();
    return tags.filter(
      (tag) =>
        !selected.includes(tag.toLocaleLowerCase()) && tag.toLocaleLowerCase().includes(needle),
    );
  }, [query, tags]);
  const expanded = open && options.length > 0;
  const choose = (tag: string) => {
    onChange(completeHostTag(query, tag));
    setIndex(-1);
    setOpen(false);
    input.current?.focus();
  };
  return (
    <div
      className="host-search"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="sidebar__filter td-search">
        <Search size={13} aria-hidden="true" />
        <input
          className="td-input"
          ref={input}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={expanded}
          aria-controls={expanded ? `${id}-options` : undefined}
          aria-activedescendant={expanded && options[index] ? `${id}-option-${index}` : undefined}
          value={query}
          onChange={(event) => {
            onChange(event.target.value);
            setIndex(-1);
            setOpen(true);
          }}
          placeholder={t("sidebar.searchPlaceholder")}
          aria-label={t("sidebar.search")}
          aria-describedby={`${id}-hint`}
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
              const next =
                event.key === "ArrowDown"
                  ? (index + 1) % options.length
                  : index <= 0
                    ? options.length - 1
                    : index - 1;
              setIndex(next);
              document
                .getElementById(`${id}-option-${next}`)
                ?.scrollIntoView?.({ block: "nearest" });
            } else if (event.key === "Enter" && expanded && (index >= 0 || completion)) {
              event.preventDefault();
              event.stopPropagation();
              choose(options[Math.max(0, index)]!);
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              setIndex(-1);
            }
          }}
        />
        {query ? (
          <IconButton
            className="host-search__clear"
            size="sm"
            label={t("sidebar.clearSearch")}
            onClick={() => {
              onChange("");
              setIndex(-1);
              input.current?.focus();
            }}
          >
            <X size={12} />
          </IconButton>
        ) : null}
        <SearchFilterMenu
          query={query}
          onChange={onChange}
          filterKeys={["tag", "is", "name", "host", "user", "port", "source", "plugin"]}
          focusInput={() => input.current?.focus()}
          presets={[
            { key: "is", value: "favorite", label: t("searchUi.favorite") },
            { key: "is", value: "discovered", label: t("hostSources.discovered") },
            { key: "source", value: "", label: t("hostSources.source") },
            { key: "plugin", value: "", label: t("searchUi.plugin") },
            { key: "name", value: "", label: t("searchUi.name") },
            { key: "host", value: "", label: t("searchUi.host") },
            { key: "user", value: "", label: t("searchUi.user") },
            { key: "port", value: "22", label: "SSH · 22" },
            ...tags.map((tag) => ({ key: "tag", value: tag, label: tag })),
          ]}
        />
      </div>
      <span id={`${id}-hint`} className="sr-only">
        {t("sidebar.searchHint")}
      </span>
      {expanded ? (
        <div className="host-search__popup">
          <div className="host-search__heading">{t("host.tags")}</div>
          <div
            id={`${id}-options`}
            role="listbox"
            aria-label={t("host.tags")}
            className="host-search__options"
          >
            {options.map((tag, position) => (
              <div
                key={tag}
                id={`${id}-option-${position}`}
                role="option"
                aria-selected={position === index}
                className={`host-search__option${position === index ? " is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setIndex(position)}
                onClick={() => choose(tag)}
              >
                <Tag size={13} aria-hidden="true" />
                <span>{tag}</span>
                <code>@tag:</code>
              </div>
            ))}
          </div>
          <div className="host-search__hint">{t("sidebar.searchHint")}</div>
        </div>
      ) : null}
    </div>
  );
}
