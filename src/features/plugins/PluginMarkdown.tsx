import { memo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";

function safeUrl(value: string): string | undefined {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password)
      return url.href;
  } catch {
    // Relative package paths cannot be resolved to a trustworthy web origin.
  }
  return undefined;
}

function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const components: Components = {
  a: ({ href, title, children }) => {
    if (!href) return <span>{children}</span>;
    const follow = (event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (href.startsWith("#")) {
        let anchor: string;
        try {
          anchor = decodeURIComponent(href.slice(1));
        } catch {
          return;
        }
        const headings = event.currentTarget
          .closest(".plugin-markdown")
          ?.querySelectorAll("h1,h2,h3,h4,h5,h6");
        [...(headings ?? [])]
          .find((heading) => headingSlug(heading.textContent ?? "") === anchor)
          ?.scrollIntoView?.({ block: "start" });
      } else {
        void api.openExternal(href).catch((error) => toast(translateError(error), "error"));
      }
    };
    return (
      <a
        href={href}
        title={title}
        rel="noopener noreferrer"
        onClick={follow}
        onAuxClick={(event) => {
          if (event.button === 1) follow(event);
        }}
      >
        {children}
      </a>
    );
  },
  // README images can point to tracking URLs or untrusted local files. Preserve the description.
  img: ({ alt }) => (alt ? <span className="plugin-markdown__image-alt">{alt}</span> : null),
  pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
  table: ({ children }) => (
    <div className="plugin-markdown__table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export const PluginMarkdown = memo(function PluginMarkdown({ source }: { source: string }) {
  return (
    <div className="plugin-markdown">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
