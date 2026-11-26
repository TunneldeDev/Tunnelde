import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { presentError } from "@/lib/api/errors";
import type { HabitCategory, HabitDetail } from "@/lib/habits/types";

export function HabitDetails({
  category,
  loadDetails,
}: {
  category: HabitCategory;
  loadDetails(category: HabitCategory): Promise<HabitDetail[]>;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<HabitDetail[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setBusy(true);
    setError(null);
    try {
      setRows(await loadDetails(category));
    } catch (failure) {
      setError(presentError(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="habits-settings__details"
      onToggle={(event) => {
        if (event.currentTarget.open && rows === null && !busy) void load();
      }}
    >
      <summary>
        {t("habits.details")} · {t(`habits.${category}.title`)}
      </summary>
      <div className="habits-settings__detail-body">
        <div className="habits-settings__detail-toolbar">
          <p>{t("habits.detailsHint")}</p>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void load()}>
            {t("habits.refreshDetails")}
          </Button>
        </div>
        {busy ? <p role="status">{t("habits.loadingDetails")}</p> : null}
        {error ? (
          <p role="alert" className="habits-settings__error">
            {error}
          </p>
        ) : null}
        {!busy && !error && rows?.length === 0 ? <p>{t("habits.emptyDetails")}</p> : null}
        {rows?.length ? (
          <dl className="habits-settings__records">
            {rows.map((row, index) => (
              <div key={index}>
                <dt>
                  {row.label}
                  <span className="habits-settings__origin">{t(`habits.${row.origin}Value`)}</span>
                </dt>
                <dd>
                  <pre>{row.value}</pre>
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </details>
  );
}
