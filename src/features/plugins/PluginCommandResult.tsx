import { Copy } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Textarea } from "@/components/ui/form/Field";
import { copyText } from "@/lib/session/clipboard";
import type { PluginOutput } from "@/store/plugins";
import "@/styles/pluginTools.css";

export function PluginCommandResult({
  result,
  onClear,
}: {
  result: PluginOutput;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section className={`plugin-tool__result${result.error ? " is-error" : ""}`}>
      <div className="plugin-tool__result-head">
        <label htmlFor={id}>{result.title || t("pluginView.result")}</label>
        <Button
          variant="ghost"
          size="sm"
          leading={<Copy size={13} />}
          onClick={() => void copyText(result.text)}
        >
          {t("pluginView.copyResult")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t("pluginView.clearResult")}
        </Button>
      </div>
      <Textarea
        id={id}
        readOnly
        value={result.text}
        rows={12}
        spellCheck={false}
        aria-invalid={result.error || undefined}
      />
      {result.error && (
        <span role="alert" className="plugin-tool__announcement">
          {result.text}
        </span>
      )}
    </section>
  );
}
