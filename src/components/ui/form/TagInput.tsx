// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { X } from "lucide-react";
import { useState } from "react";

export interface TagInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  placeholder?: string;
  max?: number;
}

/** Chip based tag editor: Enter or comma adds, Backspace removes the last. */
export function TagInput({ value, onChange, label, placeholder, max = 12 }: TagInputProps) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const tag = draft.trim();
    setDraft("");
    if (!tag || value.includes(tag) || value.length >= max) {
      return;
    }
    onChange([...value, tag]);
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
        className="td-tags__input"
        value={draft}
        spellCheck={false}
        placeholder={value.length === 0 ? placeholder : undefined}
        onChange={(event) => {
          const text = event.target.value;
          if (!text.includes(",")) {
            setDraft(text);
            return;
          }
          const parts = text.split(",");
          const last = parts.pop() ?? "";
          const merged = [...value];
          for (const part of parts) {
            const tag = part.trim();
            if (tag && !merged.includes(tag) && merged.length < max) {
              merged.push(tag);
            }
          }
          onChange(merged);
          setDraft(last.trimStart());
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
            return;
          }
          if (event.key === "Backspace" && draft.length === 0 && value.length > 0) {
            event.preventDefault();
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
