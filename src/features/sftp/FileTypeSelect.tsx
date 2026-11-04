import { useRef } from "react";
import { useTranslation } from "react-i18next";

/** An input proxy lets platform IMEs commit text without displaying an editor. */
export function FileTypeSelect({ onText }: { onText: (text: string, at: number) => void }) {
  const { t } = useTranslation();
  const composition = useRef<{ text: string; at: number } | null>(null);
  return (
    <input
      className="sftp-type-select"
      tabIndex={-1}
      aria-label={t("sftp.typeToSelect")}
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      onCompositionEnd={(event) => {
        const text = event.data;
        composition.current = { text, at: Date.now() };
        event.currentTarget.value = "";
        if (text) onText(text, event.timeStamp);
      }}
      onChange={(event) => {
        if ((event.nativeEvent as InputEvent).isComposing) return;
        const text = event.currentTarget.value;
        event.currentTarget.value = "";
        if (composition.current?.text === text && Date.now() - composition.current.at < 100) {
          composition.current = null;
          return;
        }
        composition.current = null;
        if (text) onText(text, event.timeStamp);
      }}
    />
  );
}
