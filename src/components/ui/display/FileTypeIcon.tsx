import {
  File,
  Folder,
  FileCode2,
  FileJson,
  FileText,
  FileImage,
  FileAudio,
  FileVideo,
  FileArchive,
  FileSpreadsheet,
  SquareTerminal,
  FileCog,
  KeyRound,
  Database,
  Type,
  Binary,
} from "lucide-react";
import type { FileIconSymbol, PluginFileIcon } from "@/lib/api/types";

const SYMBOLS = {
  file: File,
  code: FileCode2,
  json: FileJson,
  text: FileText,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  pdf: FileText,
  spreadsheet: FileSpreadsheet,
  terminal: SquareTerminal,
  settings: FileCog,
  key: KeyRound,
  database: Database,
  font: Type,
  binary: Binary,
  markdown: FileText,
} satisfies Record<FileIconSymbol, typeof File>;

/** Data-only icons: plugin content cannot inject markup, URLs, fonts or stylesheets. */
export function FileTypeIcon({
  icon,
  isDir = false,
  size = 16,
}: {
  icon?: PluginFileIcon;
  isDir?: boolean;
  size?: number;
}) {
  if (isDir) return <Folder size={size} aria-hidden="true" />;
  const color = /^#[0-9a-f]{6}$/i.test(icon?.color ?? "") ? icon!.color : undefined;
  const label = /^[a-z0-9]{1,4}$/i.test(icon?.label ?? "") ? icon!.label : undefined;
  if (label)
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        style={{ color, flexShrink: 0 }}
      >
        <path
          d="M5 2h9l5 5v15H5Z"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="currentColor"
          fillOpacity=".12"
        />
        <path d="M14 2v6h5" stroke="currentColor" strokeWidth="1.5" />
        <text
          x="12"
          y="17"
          textAnchor="middle"
          fill="currentColor"
          fontSize={label.length > 2 ? 7 : 9}
          fontWeight="700"
          fontFamily="var(--td-mono)"
        >
          {label}
        </text>
      </svg>
    );
  const Glyph = SYMBOLS[icon?.symbol ?? "file"] ?? File;
  return <Glyph size={size} color={color} aria-hidden="true" style={{ flexShrink: 0 }} />;
}
