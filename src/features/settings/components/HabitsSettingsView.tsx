import { HabitDetails } from "./HabitDetails";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import {
  HABIT_CATEGORIES,
  type HabitCategory,
  type HabitDetail,
  type HabitsData,
} from "@/lib/habits/types";
import { presentError } from "@/lib/api/errors";
import "../habitsSettings.css";

export function HabitsSettingsView({
  data,
  reset,
  loadDetails,
  selectSection,
}: {
  data: HabitsData;
  loadDetails(category: HabitCategory): Promise<HabitDetail[]>;
  reset(categories: HabitCategory[]): Promise<void>;
  selectSection(section: "appearance" | "workspace" | "files"): void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<HabitCategory[]>([]);
  const [revision, setRevision] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="habits-settings">
      <p>{t("habits.description")}</p>
      <p className="habits-settings__status" role="status">
        {t(data.saving ? "habits.saving" : data.ready ? "habits.saved" : "habits.unavailable", {
          count: data.entries,
        })}
      </p>
      {data.error || error ? (
        <p className="habits-settings__error" role="alert">
          {error ?? data.error}
        </p>
      ) : null}
      {data.workspaceCleared ? (
        <p className="habits-settings__notice" role="status">
          {t("habits.workspaceCleared")}
        </p>
      ) : null}
      <fieldset disabled={busy || !data.ready} className="habits-settings__categories">
        <legend>{t("habits.choose")}</legend>
        {HABIT_CATEGORIES.map((category) => (
          <div key={category} className="habits-settings__category">
            <label className="habits-settings__selection">
              <input
                type="checkbox"
                checked={selected.includes(category)}
                onChange={(event) =>
                  setSelected((items) =>
                    event.target.checked
                      ? [...items, category]
                      : items.filter((v) => v !== category),
                  )
                }
              />
              <span>
                <strong>{t(`habits.${category}.title`)}</strong>
                <span>{t(`habits.${category}.hint`)}</span>
              </span>
            </label>
            <HabitDetails
              key={`${category}:${revision}`}
              category={category}
              loadDetails={loadDetails}
            />
          </div>
        ))}
      </fieldset>
      <div className="habits-settings__actions">
        <Button
          variant="danger"
          disabled={!selected.length || busy || !data.ready || data.saving}
          onClick={() => setReviewing(true)}
        >
          {t("habits.resetSelected")}
        </Button>
        <Button variant="secondary" onClick={() => selectSection("appearance")}>
          {t("habits.manageFonts")}
        </Button>
        <Button variant="secondary" onClick={() => selectSection("workspace")}>
          {t("habits.manageLayout")}
        </Button>
        <Button variant="secondary" onClick={() => selectSection("files")}>
          {t("habits.manageFiles")}
        </Button>
      </div>
      {reviewing ? (
        <Dialog
          open
          closeLabel={t("common.close")}
          title={t("habits.confirmTitle")}
          onClose={() => {
            if (!busy) setReviewing(false);
          }}
          footer={
            <>
              <Button
                autoFocus
                variant="secondary"
                disabled={busy}
                onClick={() => setReviewing(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await reset(selected);
                    setRevision((v) => v + 1);
                    setSelected([]);
                    setReviewing(false);
                  } catch (failure) {
                    setError(presentError(failure));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("habits.resetSelected")}
              </Button>
            </>
          }
        >
          <p>{t("habits.confirmBody")}</p>
          {selected.includes("workspace") ? (
            <p className="habits-settings__notice">{t("habits.workspaceCleared")}</p>
          ) : null}
          <ul>
            {selected.map((category) => (
              <li key={category}>{t(`habits.${category}.title`)}</li>
            ))}
          </ul>
        </Dialog>
      ) : null}
    </div>
  );
}
