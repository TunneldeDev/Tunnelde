// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Select } from "@/components/ui/form/Select";
import { TagInput, type TagInputHandle, type TagInputProps } from "@/components/ui/form/TagInput";

const options = [
  { value: "en", label: "English" },
  { value: "zh", label: "Chinese" },
  { value: "system", label: "System" },
];

function Tags({
  initial = [],
  ...props
}: Omit<TagInputProps, "value" | "onChange" | "label"> & { initial?: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TagInput {...props} label="Tags" value={value} onChange={setValue} />
      <output aria-label="Saved tags">{JSON.stringify(value)}</output>
    </>
  );
}
const saved = () => JSON.parse(screen.getByLabelText("Saved tags").textContent!) as string[];

describe("Select keyboard and focus", () => {
  it("navigates options without changing the value until Space commits", () => {
    const change = vi.fn();
    render(<Select label="Language" value="en" options={options} onChange={change} />);
    const trigger = screen.getByRole("button", { name: "Language" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "End" });
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: " " });
    expect(change).toHaveBeenCalledWith("system");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("supports typeahead, Home and Escape without committing", () => {
    const change = vi.fn();
    render(<Select label="Language" value="en" options={options} onChange={change} />);
    const trigger = screen.getByRole("button", { name: "Language" });
    fireEvent.keyDown(trigger, { key: "c" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: "Chinese" }).id,
    );
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(trigger.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: "English" }).id,
    );
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(change).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Tab and outside focus, and disables an already open popup", () => {
    const change = vi.fn();
    const { rerender } = render(
      <>
        <Select label="Language" value="en" options={options} onChange={change} />
        <button>Next</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Language" });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    act(() => trigger.focus());
    fireEvent.click(trigger);
    act(() => screen.getByRole("button", { name: "Next" }).focus());
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    rerender(
      <>
        <Select label="Language" value="en" options={options} onChange={change} disabled />
        <button>Next</button>
      </>,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    rerender(
      <>
        <Select label="Language" value="en" options={options} onChange={change} />
        <button>Next</button>
      </>,
    );
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(change).not.toHaveBeenCalled();
  });

  it("keeps click selection inside the portal from acting as an outside click", () => {
    const change = vi.fn();
    render(<Select label="Language" value="en" options={options} onChange={change} />);
    const trigger = screen.getByRole("button", { name: "Language" });
    fireEvent.click(trigger);
    const option = screen.getByRole("option", { name: "Chinese" });
    fireEvent.pointerDown(option);
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(change).toHaveBeenCalledWith("zh");
    expect(document.activeElement).toBe(trigger);
  });
});

describe("TagInput editing", () => {
  it("includes an uncommitted draft when the parent submits and commits it on blur", () => {
    const ref = createRef<TagInputHandle>();
    render(<Tags initial={["prod"]} ref={ref} />);
    const input = screen.getByRole("combobox", { name: "Tags" });
    fireEvent.change(input, { target: { value: "  中文  " } });
    expect(ref.current?.getValue()).toEqual(["prod", "中文"]);
    fireEvent.blur(input);
    expect(saved()).toEqual(["prod", "中文"]);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("keeps Chinese composition intact and commits only after IME confirmation", () => {
    render(<Tags />);
    const input = screen.getByRole("combobox", { name: "Tags" });
    act(() => input.focus());
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "生产" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(saved()).toEqual([]);
    fireEvent.compositionEnd(input, { data: "生产" });
    expect(saved()).toEqual([]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(saved()).toEqual(["生产"]);
  });

  it("does not lose a composition that ends after focus leaves the input", () => {
    render(
      <>
        <Tags />
        <button>Next</button>
      </>,
    );
    const input = screen.getByRole("combobox", { name: "Tags" });
    act(() => input.focus());
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "测试" } });
    act(() => screen.getByRole("button", { name: "Next" }).focus());
    expect(saved()).toEqual([]);
    fireEvent.compositionEnd(input, { data: "测试" });
    expect(saved()).toEqual(["测试"]);
  });

  it("pastes comma, Chinese comma and newline separated tags with deduplication and limits", () => {
    render(<Tags initial={["prod"]} max={4} />);
    const input = screen.getByRole("combobox", { name: "Tags" });
    fireEvent.paste(input, {
      clipboardData: { getData: () => `prod，测试\r\n${"长".repeat(25)},dev,stage,ignored` },
    });
    expect(saved()).toEqual(["prod", "测试", "dev", "stage"]);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("selects suggestions by keyboard and dismisses them before propagating Escape", () => {
    const escape = vi.fn();
    render(
      <div onKeyDown={escape}>
        <Tags suggestions={["Production", "Prototype", "Production"]} />
      </div>,
    );
    const input = screen.getByRole("combobox", { name: "Tags" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "pro" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(saved()).toEqual(["Prototype"]);
    fireEvent.change(input, { target: { value: "pro" } });
    escape.mockClear();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(escape).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(escape).toHaveBeenCalledTimes(1);
  });

  it("preserves input focus when choosing a suggestion and removes only an empty draft's last tag", () => {
    render(<Tags initial={["dev"]} suggestions={["Production"]} />);
    const input = screen.getByRole("combobox", { name: "Tags" });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: "pro" } });
    const option = screen.getByRole("option", { name: "Production" });
    expect(option.tabIndex).toBe(-1);
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(saved()).toEqual(["dev", "Production"]);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(saved()).toEqual(["dev"]);
    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(saved()).toEqual(["dev"]);
  });
});
