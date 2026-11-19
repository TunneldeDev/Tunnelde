import { useState, type InputHTMLAttributes, type Ref } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./Button";
import { Input } from "./Field";
import "./passwordInput.css";

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  ref?: Ref<HTMLInputElement>;
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
  onCopy?: () => void;
  copyLabel?: string;
}

/** The reveal action lives inside the field; the caller still owns password and copy consent. */
export function PasswordInput({
  revealed,
  onRevealedChange,
  onCopy,
  copyLabel,
  disabled,
  ...props
}: PasswordInputProps) {
  const { t } = useTranslation();
  const [localRevealed, setLocalRevealed] = useState(false);
  const shown = revealed ?? localRevealed;
  return (
    <span className={`td-password-input${onCopy ? " has-copy" : ""}`}>
      <Input
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        {...props}
        disabled={disabled}
        type={shown ? "text" : "password"}
      />
      <span className="td-password-input__actions">
        {onCopy && copyLabel ? (
          <IconButton size="sm" label={copyLabel} disabled={disabled} onClick={onCopy}>
            <Copy size={14} />
          </IconButton>
        ) : null}
        <IconButton
          size="sm"
          label={t(shown ? "common.hidePassword" : "common.showPassword")}
          aria-pressed={shown}
          disabled={disabled}
          onPointerDown={(event) => {
            // Keep the insertion point for mouse users, but don't alter keyboard focus.
            if (event.pointerType === "mouse") event.preventDefault();
          }}
          onClick={() => {
            setLocalRevealed(!shown);
            onRevealedChange?.(!shown);
          }}
        >
          {shown ? <EyeOff size={14} /> : <Eye size={14} />}
        </IconButton>
      </span>
    </span>
  );
}
