import type { FileColumn } from "./view";

const CELL_CLASS: Record<FileColumn, string> = {
  name: "sftp-row__name",
  type: "sftp-row__type",
  size: "sftp-row__size",
  modified: "sftp-row__time",
};

/** Measure rendered text, including text hidden by ellipsis, without changing selection. */
export function fitFileColumn(header: HTMLElement, column: FileColumn): number {
  const range = header.ownerDocument.createRange();
  const textWidth = (element: Element | null) => {
    if (!element?.textContent) return 0;
    range.selectNodeContents(element);
    return range.getBoundingClientRect().width;
  };
  const nameInset = column === "name" ? 24 : 0;
  // Reserve the sorting arrow even for inactive columns so sorting never clips the label.
  let width = textWidth(header.querySelector("button span")) + nameInset + 14 + 8;
  const pane = header.closest(".sftp-pane");
  for (const cell of pane?.querySelectorAll(`.sftp-pane__body .${CELL_CLASS[column]}`) ?? []) {
    width = Math.max(width, textWidth(cell) + nameInset + 8);
  }
  return Math.max(56, Math.min(1000, Math.ceil(width)));
}
