// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { X } from "lucide-react";
import { useId, useImperativeHandle, useRef, useState, type Ref } from "react";

export interface TagInputHandle {
  getValue: () => string[];
}
export interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  placeholder?: string;
  max?: number;
  ref?: Ref<TagInputHandle>;
  suggestions?: string[];
}

/** Chip based tag editor: Enter or comma adds, Backspace removes the last. */
export function TagInput({
  value,
  onChange,
  label,
  placeholder,
  max = 12,
  ref,
  suggestions = [],
}: TagInputProps) {
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [suggestionsHidden, setSuggestionsHidden] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const collected = (text = draft) =>
    Array.from(
      new Set([
        ...value,
        ...text
          .split(/[,，\r\n]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ]),
    )
      .filter((tag) => Array.from(tag).length <= 24)
      .slice(0, max);
  useImperativeHandle(ref, () => ({ getValue: () => collected() }));
  const matches = Array.from(new Set(suggestions))
    .filter(
      (tag) =>
        tag.trim() === tag &&
        tag.length > 0 &&
        Array.from(tag).length <= 24 &&
        !value.includes(tag) &&
        tag.toLocaleLowerCase().includes(draft.trim().toLocaleLowerCase()),
    )
    .slice(0, 6);
  const showSuggestions =
    focused &&
    !suggestionsHidden &&
    !isComposing &&
    !!draft.trim() &&
    matches.length > 0 &&
    value.length < max;

  const commit = (text = draft) => {
    if (composing.current) return;
    onChange(collected(text));
    setDraft("");
    setHighlight(-1);
  };
  const changeDraft = (text: string) => {
    setHighlight(-1);
    setSuggestionsHidden(false);
    if (composing.current || !/[,，\r\n]/.test(text)) {
      setDraft(text);
      return;
    }
    const parts = text.split(/[,，\r\n]/);
    const last = parts.pop() ?? "";
    onChange(collected(parts.join(",")));
    setDraft(last.trimStart());
  };
  const choose = (tag: string) => {
    onChange(Array.from(new Set([...value, tag])).slice(0, max));
    setDraft("");
    setHighlight(-1);
    input.current?.focus();
  };

  return (
    <div className="td-tags" role="group" aria-label={label}>
      {value.map((tag) => (
        <span className="td-tag" key={tag}>
          {tag}
          <button
            type="button"
            aria-label={`${label}: ${tag}`}
            onClick={() => onChange(value.filter((item) => item !== tag))}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        ref={input}
        className="td-tags__input"
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showSuggestions}
        aria-controls={showSuggestions ? listId : undefined}
        aria-activedescendant={
          showSuggestions && matches[highlight] ? `${listId}-${highlight}` : undefined
        }
        value={draft}
        spellCheck={false}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(event) => changeDraft(event.target.value)}
        onPaste={(event) => {
          if (composing.current) return;
          const text = event.clipboardData.getData("text");
          if (!/[,，\r\n]/.test(text)) return;
          event.preventDefault();
          const element = event.currentTarget;
          const next =
            draft.slice(0, element.selectionStart ?? draft.length) +
            text +
            draft.slice(element.selectionEnd ?? draft.length);
          commit(next);
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape" && showSuggestions) {
            event.preventDefault();
            event.stopPropagation();
            setSuggestionsHidden(true);
            setHighlight(-1);
            return;
          }
          if (showSuggestions && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const delta = event.key === "ArrowDown" ? 1 : -1;
            setHighlight((index) =>
              index < 0
                ? delta > 0
                  ? 0
                  : matches.length - 1
                : (index + delta + matches.length) % matches.length,
            );
            return;
          }
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            if (event.key === "Enter" && showSuggestions && matches[highlight])
              choose(matches[highlight]!);
            else commit();
            return;
          }
          if (event.key === "Backspace" && draft.length === 0 && value.length > 0) {
            event.preventDefault();
            onChange(value.slice(0, -1));
          }
        }}
        onFocus={() => {
          setFocused(true);
          setSuggestionsHidden(false);
        }}
        onCompositionStart={() => {
          composing.current = true;
          setIsComposing(true);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          setIsComposing(false);
          if (document.activeElement !== event.currentTarget) commit(event.currentTarget.value);
          else changeDraft(event.currentTarget.value);
        }}
        onBlur={(event) => {
          setFocused(false);
          commit(event.currentTarget.value);
        }}
      />
      {showSuggestions ? (
        <div className="td-tags__suggestions" role="listbox" id={listId} aria-label={label}>
          {matches.map((tag, index) => (
            <button
              key={tag}
              type="button"
              role="option"
              id={`${listId}-${index}`}
              tabIndex={-1}
              aria-selected={index === highlight}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
