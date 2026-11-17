import { memo, type CSSProperties } from "react";
import { syntaxSegments, type SyntaxToken, type SyntaxTokenType } from "@/lib/plugins/syntax";
import "./editorSyntax.css";

export interface EditorSyntaxMetrics {
  font: string;
  fontSize: string;
  lineHeight: string;
  tabSize: string;
  wordWrap: boolean;
  padding: string;
  paddingInline: number;
  contentWidth: number;
  border: string;
  scrollbarWidth: number;
  scrollbarHeight: number;
  scrollTop: number;
  scrollLeft: number;
}

const TYPE_CLASS: Record<SyntaxTokenType, string> = {
  keyword: "td-syntax--keyword",
  string: "td-syntax--string",
  number: "td-syntax--number",
  comment: "td-syntax--comment",
  type: "td-syntax--type",
  function: "td-syntax--function",
  property: "td-syntax--property",
  operator: "td-syntax--operator",
  punctuation: "td-syntax--punctuation",
  variable: "td-syntax--variable",
  constant: "td-syntax--constant",
  invalid: "td-syntax--invalid",
};

export const EditorSyntaxOverlay = memo(function EditorSyntaxOverlay({
  content,
  tokens,
  metrics,
  visible,
}: {
  content: string;
  tokens: readonly SyntaxToken[];
  metrics: EditorSyntaxMetrics;
  visible: boolean;
}) {
  if (!visible || tokens.length === 0) return null;
  const viewportStyle: CSSProperties = {
    right: `${metrics.scrollbarWidth}px`,
    bottom: `${metrics.scrollbarHeight}px`,
  };
  const contentStyle: CSSProperties = {
    fontFamily: metrics.font,
    fontSize: metrics.fontSize,
    lineHeight: metrics.lineHeight,
    tabSize: metrics.tabSize,
    padding: metrics.padding,
    border: metrics.border,
    whiteSpace: metrics.wordWrap ? "pre-wrap" : "pre",
    overflowWrap: metrics.wordWrap ? "anywhere" : "normal",
    transform: `translate(${-metrics.scrollLeft}px, ${-metrics.scrollTop}px)`,
    width: metrics.contentWidth ? `${metrics.contentWidth}px` : "100%",
    minHeight: `100%`,
  };
  return (
    <div className="td-syntax-overlay" aria-hidden="true" style={viewportStyle}>
      <pre className="td-syntax-overlay__content" style={contentStyle}>
        {syntaxSegments(content, tokens).map((segment, index) =>
          segment.type ? (
            <span key={index} className={TYPE_CLASS[segment.type]}>
              {segment.text}
            </span>
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </pre>
    </div>
  );
});
