import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./Button";
import { Input } from "./Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import {
  clamp,
  hexToRgb,
  hsvToRgb,
  normalizeHex,
  rgbToHex,
  rgbToHsv,
  type Hsv,
} from "@/lib/prefs/colorMath";

export interface ColorPreset {
  value: string;
  color: string;
  label: string;
}
export interface ColorPickerProps {
  value: string;
  label: string;
  defaultValue?: string;
  presets?: ColorPreset[];
  onChange: (value: string) => void;
  onReset?: () => void;
  onPreview?: (value: string | null) => void;
}
const NO_PRESETS: ColorPreset[] = [];
const resolveColor = (value: string, presets: ColorPreset[]) =>
  normalizeHex(value) ?? presets.find((preset) => preset.value === value)?.color ?? "#2f6fed";

/** Explicit Apply/Cancel keeps pointer previews out of the persistence queue. */
export function ColorPicker(props: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const presets = props.presets ?? NO_PRESETS;
  const hex = resolveColor(props.value, presets);
  return (
    <>
      <button
        type="button"
        className="td-color-trigger"
        aria-label={props.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="td-color-chip" style={{ background: hex }} aria-hidden="true" />
        <span>
          {presets.find((preset) => preset.value === props.value)?.label ?? hex.toUpperCase()}
        </span>
      </button>
      {open ? (
        <ColorPickerPanel {...props} presets={presets} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

function ColorPickerPanel({
  value,
  label,
  defaultValue,
  presets = NO_PRESETS,
  onChange,
  onReset,
  onPreview,
  onClose,
}: ColorPickerProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const initial = resolveColor(value, presets);
  const [choice, setChoice] = useState(value);
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(hexToRgb(initial)));
  const [hexDraft, setHexDraft] = useState(initial);
  const [rgbDraft, setRgbDraft] = useState(() => {
    const rgb = hexToRgb(initial);
    return { r: String(rgb.r), g: String(rgb.g), b: String(rgb.b) };
  });
  const [invalid, setInvalid] = useState<"hex" | "rgb" | null>(null);
  const [resetToDefault, setResetToDefault] = useState(false);
  const dragging = useRef(false);
  const previewCallback = useRef(onPreview);
  const description = useId();
  const hex = rgbToHex(hsvToRgb(hsv));
  useEffect(() => {
    previewCallback.current = onPreview;
  }, [onPreview]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => previewCallback.current?.(choice));
    return () => cancelAnimationFrame(frame);
  }, [choice]);
  useEffect(() => () => previewCallback.current?.(null), []);

  const sync = (next: Hsv, nextChoice = rgbToHex(hsvToRgb(next))) => {
    const nextHex = rgbToHex(hsvToRgb(next));
    const rgb = hexToRgb(nextHex);
    setHsv(next);
    setChoice(nextChoice);
    setHexDraft(nextHex);
    setRgbDraft({ r: String(rgb.r), g: String(rgb.g), b: String(rgb.b) });
    setInvalid(null);
    setResetToDefault(false);
  };
  const choose = (next: string) => sync(rgbToHsv(hexToRgb(resolveColor(next, presets))), next);
  const pointerColor = (element: HTMLElement, x: number, y: number) => {
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    sync({
      ...hsv,
      s: clamp((x - bounds.left) / bounds.width),
      v: 1 - clamp((y - bounds.top) / bounds.height),
    });
  };
  const applyHex = (text: string) => {
    setResetToDefault(false);
    setHexDraft(text);
    const normalized = normalizeHex(text);
    if (normalized) {
      const rgb = hexToRgb(normalized);
      setHsv(rgbToHsv(rgb));
      setChoice(normalized);
      setRgbDraft({ r: String(rgb.r), g: String(rgb.g), b: String(rgb.b) });
    }
    setInvalid(normalized ? null : "hex");
  };
  const applyRgb = (channel: "r" | "g" | "b", text: string) => {
    setResetToDefault(false);
    const next = { ...rgbDraft, [channel]: text };
    setRgbDraft(next);
    const valid = Object.values(next).every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) <= 255,
    );
    if (valid) {
      const rgb = { r: Number(next.r), g: Number(next.g), b: Number(next.b) };
      const color = rgbToHex(rgb);
      setHsv(rgbToHsv(rgb));
      setChoice(color);
      setHexDraft(color);
    }
    setInvalid(valid ? null : "rgb");
  };
  return (
    <Dialog
      open
      title={label}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={328}
      className="td-color-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={invalid !== null}
            onClick={() => {
              if (resetToDefault && onReset) onReset();
              else onChange(choice);
              onClose();
            }}
          >
            {t("common.apply")}
          </Button>
        </>
      }
    >
      <div className="td-color-panel">
        <div
          className="td-color-sv"
          role="slider"
          tabIndex={0}
          aria-label={t("color.saturationValue")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(hsv.s * 100)}
          aria-valuetext={t("color.svValue", {
            s: Math.round(hsv.s * 100),
            v: Math.round(hsv.v * 100),
          })}
          aria-describedby={description}
          style={{ backgroundColor: `hsl(${hsv.h}, 100%, 50%)` }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.focus();
            dragging.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            pointerColor(event.currentTarget, event.clientX, event.clientY);
          }}
          onPointerMove={(event) => {
            if (dragging.current) pointerColor(event.currentTarget, event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            dragging.current = false;
            if (event.currentTarget.hasPointerCapture?.(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onLostPointerCapture={() => {
            dragging.current = false;
          }}
          onKeyDown={(event) => {
            if (
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            const step = event.shiftKey ? 0.1 : 0.01;
            sync({
              ...hsv,
              s:
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 1
                    : clamp(
                        hsv.s +
                          (event.key === "ArrowLeft"
                            ? -step
                            : event.key === "ArrowRight"
                              ? step
                              : 0),
                      ),
              v: clamp(
                hsv.v + (event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0),
              ),
            });
          }}
        >
          <span
            className="td-color-sv__cursor"
            style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }}
          />
        </div>
        <p id={description} className="sr-only">
          {t("color.keyboardHint")}
        </p>
        <label className="td-color-hue">
          <span className="sr-only">{t("color.hue")}</span>
          <input
            type="range"
            min={0}
            max={360}
            step={1}
            value={hsv.h}
            onChange={(event) => sync({ ...hsv, h: Number(event.target.value) })}
          />
        </label>
        <div className="td-color-values">
          <label className="td-color-hex">
            <span>{t("color.hex")}</span>
            <Input
              autoFocus
              value={hexDraft}
              spellCheck={false}
              aria-invalid={invalid === "hex" || undefined}
              onChange={(event) => applyHex(event.target.value)}
            />
          </label>
          {(["r", "g", "b"] as const).map((channel) => (
            <label key={channel}>
              <span>
                {t(channel === "r" ? "color.red" : channel === "g" ? "color.green" : "color.blue")}
              </span>
              <Input
                type="number"
                min={0}
                max={255}
                value={rgbDraft[channel]}
                aria-invalid={
                  (invalid === "rgb" &&
                    (!/^\d{1,3}$/.test(rgbDraft[channel]) || Number(rgbDraft[channel]) > 255)) ||
                  undefined
                }
                onChange={(event) => applyRgb(channel, event.target.value)}
              />
            </label>
          ))}
        </div>
        {invalid ? (
          <p role="alert" className="td-color-error">
            {t("color.invalid")}
          </p>
        ) : null}
        {presets.length ? (
          <div className="td-color-presets" role="group" aria-label={t("color.presets")}>
            {presets.map((preset) => (
              <button
                type="button"
                key={preset.value}
                aria-label={preset.label}
                aria-pressed={choice === preset.value}
                style={{ background: preset.color }}
                onClick={() => choose(preset.value)}
              />
            ))}
          </div>
        ) : null}
        <div className="td-color-comparison">
          <span style={{ background: initial }} title={t("color.current")} />
          <span style={{ background: hex }} title={t("color.preview")} />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              choose(defaultValue ?? initial);
              setResetToDefault(true);
            }}
          >
            {t("color.reset")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
