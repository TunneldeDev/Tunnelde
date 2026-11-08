import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import {
  GlobalWorkerOptions,
  PDFDataRangeTransport,
  getDocument,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { Button } from "@/components/ui/form/Button";
import { readPreviewRange } from "@/lib/files/preview";
import { translateError } from "@/lib/api/errors";

GlobalWorkerOptions.workerSrc = workerUrl;

// Vite emits local assets with content hashes; PDF requests never go to a CDN.
const assets = import.meta.glob<string>(
  [
    "/node_modules/pdfjs-dist/cmaps/*.bcmap",
    "/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}",
    "/node_modules/pdfjs-dist/wasm/{openjpeg,jbig2,qcms_bg}.wasm",
    "/node_modules/pdfjs-dist/wasm/{openjpeg,jbig2}_nowasm_fallback.js",
  ],
  { query: "?url", import: "default", eager: true },
);
const notices = import.meta.glob<string>(
  [
    "/node_modules/pdfjs-dist/LICENSE",
    "/node_modules/pdfjs-dist/cmaps/LICENSE",
    "/node_modules/pdfjs-dist/standard_fonts/LICENSE_*",
    "/node_modules/pdfjs-dist/wasm/LICENSE_{JBIG2,OPENJPEG,PDFJS_JBIG2,PDFJS_OPENJPEG,PDFJS_QCMS,QCMS}",
  ],
  { query: "?raw", import: "default", eager: true },
);
const binaryUrls = new Map(
  Object.entries(assets).map(([path, url]) => [path.split("/").pop()!, url]),
);

class LocalBinaryDataFactory {
  async fetch({ filename }: { kind: string; filename: string }) {
    const url = binaryUrls.get(filename);
    if (!url) throw new Error("Missing bundled PDF resource");
    const result = await fetch(url);
    if (!result.ok) throw new Error("Unable to load bundled PDF resource");
    return new Uint8Array(await result.arrayBuffer());
  }
}

/** Render one bounded canvas; no embedded scripts, form execution or external document links. */
export default function PdfPreview({ url, size }: { url: string; size: number }) {
  const { t } = useTranslation();
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const [rendering, setRendering] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const renderQueue = useRef(Promise.resolve());
  const [width, setWidth] = useState(680);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let requestQueue = Promise.resolve();
    const transport = new (class extends PDFDataRangeTransport {
      override requestDataRange(begin: number, end: number) {
        // Serialize range loading so even files requesting many spans cannot flood SSH.
        requestQueue = requestQueue
          .then(async () => {
            if (controller.signal.aborted) return;
            if (end - begin > 16 * 1024 * 1024)
              throw Object.assign(new Error("preview.pdfRangeLimit"), { code: "validation" });
            const bytes = new Uint8Array(end - begin);
            for (let start = begin; start < end; start += 1024 * 1024) {
              const finish = Math.min(start + 1024 * 1024, end);
              const chunk = await readPreviewRange(url, start, finish, controller.signal);
              bytes.set(chunk, start - begin);
            }
            if (!controller.signal.aborted) this.onDataRange(begin, bytes);
          })
          .catch((cause: unknown) => {
            if (!disposed) {
              setFailure((previous) => previous ?? { cause });
              void loading.destroy();
            }
          });
      }
      override abort() {
        controller.abort();
      }
    })(size, null, true);
    const loading = getDocument({
      range: transport,
      rangeChunkSize: 256 * 1024,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
      useSystemFonts: true,
      useWorkerFetch: false,
      BinaryDataFactory: LocalBinaryDataFactory,
      maxImageSize: 16 * 1024 * 1024,
      canvasMaxAreaInBytes: 64 * 1024 * 1024,
    });
    loading.onPassword = () => {
      if (!disposed) setFailure({ cause: { code: "validation", message: "preview.pdfPassword" } });
      void loading.destroy();
    };
    void loading.promise
      .then((result) => {
        if (!disposed) setDocument(result);
      })
      .catch((cause: unknown) => {
        // Destroying a rejected/password-protected document also rejects its
        // loading promise. Keep the actionable error that triggered cleanup.
        if (!disposed) setFailure((previous) => previous ?? { cause });
      });
    return () => {
      disposed = true;
      controller.abort();
      void loading.destroy();
    };
  }, [url, size]);
  useEffect(() => {
    const target = container.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(100, entry!.contentRect.width - 32)),
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document) return;
    let disposed = false;
    let task: RenderTask | undefined;
    renderQueue.current = renderQueue.current
      .catch(() => {})
      .then(async () => {
        if (disposed) return;
        const page = await document.getPage(pageNumber);
        if (disposed || !canvas.current) return;
        setRendering(true);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(3, width / base.width) * zoom;
        const viewport = page.getViewport({ scale });
        // Maximum 8M pixels, even for deliberately extreme page dimensions/zoom.
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          2,
          Math.sqrt(8_000_000 / (viewport.width * viewport.height)),
        );
        const target = canvas.current;
        target.width = Math.max(1, Math.floor(viewport.width * ratio));
        target.height = Math.max(1, Math.floor(viewport.height * ratio));
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        task = page.render({ canvas: target, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
        await task.promise;
        if (!disposed) {
          setRendering(false);
          page.cleanup();
        }
      })
      .catch((cause: unknown) => {
        if (!disposed) setFailure((previous) => previous ?? { cause });
      });
    return () => {
      disposed = true;
      task?.cancel();
    };
  }, [document, pageNumber, zoom, width]);
  return (
    <div className="file-preview__pdf">
      <div className="file-preview__toolbar" role="toolbar" aria-label={t("preview.pdfControls")}>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("preview.previousPage")}
          disabled={!document || pageNumber <= 1}
          onClick={() => setPageNumber((value) => value - 1)}
        >
          <ChevronLeft size={16} />
        </Button>
        <span aria-live="polite">
          {document
            ? t("preview.page", { current: pageNumber, total: document.numPages })
            : t("common.loading")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("preview.nextPage")}
          disabled={!document || pageNumber >= document.numPages}
          onClick={() => setPageNumber((value) => value + 1)}
        >
          <ChevronRight size={16} />
        </Button>
        <span className="file-preview__toolbar-divider" />
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("preview.zoomOut")}
          disabled={zoom <= 0.5}
          onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))}
        >
          <Minus size={16} />
        </Button>
        <span>{Math.round(zoom * 100)}%</span>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("preview.zoomIn")}
          disabled={zoom >= 3}
          onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
        >
          <Plus size={16} />
        </Button>
      </div>
      {failure ? <p role="alert">{translateError(failure.cause)}</p> : null}
      <div className="file-preview__pdf-pages" ref={container} aria-busy={rendering && !failure}>
        {!failure ? (
          <canvas ref={canvas} aria-label={t("preview.pdfPage", { page: pageNumber })} role="img" />
        ) : null}
      </div>
      <details className="file-preview__licenses">
        <summary>PDF.js · Third-party licenses</summary>
        {Object.entries(notices).map(([path, text]) => (
          <pre key={path}>{text}</pre>
        ))}
      </details>
    </div>
  );
}
