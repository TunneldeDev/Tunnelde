import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Field } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import type { ConnectionRoute } from "@/lib/api/network";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";

export function ConnectionRouteEditor({
  hostId,
  value,
  onChange,
}: {
  hostId?: string;
  value: ConnectionRoute;
  onChange: (route: ConnectionRoute) => void;
}) {
  const { t } = useTranslation();
  const hosts = useHosts((s) => s.hosts);
  const profiles = useSettings((s) => s.settings.network?.profiles ?? []);
  const [adding, setAdding] = useState("");
  const move = (index: number, direction: number) => {
    const jumpHosts = [...value.jumpHosts];
    [jumpHosts[index], jumpHosts[index + direction]] = [
      jumpHosts[index + direction]!,
      jumpHosts[index]!,
    ];
    onChange({ ...value, jumpHosts });
  };
  return (
    <details className="connection-route">
      <summary>
        {t("network.route")}
        {value.jumpHosts.length ? ` · ${value.jumpHosts.length}` : ""}
      </summary>
      <div className="form-grid">
        <Field label={t("network.proxy")}>
          <Select
            label={t("network.proxy")}
            value={value.proxy}
            options={[
              { value: "", label: t("network.inherit") },
              { value: "system", label: t("network.system") },
              { value: "direct", label: t("network.direct") },
              ...profiles.map((p) => ({ value: p.id, label: p.name })),
              ...(!["", "system", "direct"].includes(value.proxy) &&
              !profiles.some((p) => p.id === value.proxy)
                ? [{ value: value.proxy, label: t("network.missingProxy") }]
                : []),
            ]}
            onChange={(proxy) => onChange({ ...value, proxy })}
          />
        </Field>
        <Field label={t("network.jumpHosts")} hint={t("network.jumpHint")}>
          <ol className="connection-route__hops">
            {value.jumpHosts.map((id, index) => (
              <li key={id}>
                <span>{hosts.find((h) => h.id === id)?.name ?? t("network.hostMissing")}</span>
                <IconButton
                  label={t("network.moveUp")}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton
                  label={t("network.moveDown")}
                  disabled={index === value.jumpHosts.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown size={13} />
                </IconButton>
                <IconButton
                  label={t("common.delete")}
                  onClick={() =>
                    onChange({ ...value, jumpHosts: value.jumpHosts.filter((h) => h !== id) })
                  }
                >
                  <X size={13} />
                </IconButton>
              </li>
            ))}
          </ol>
          {value.jumpHosts.length < 8 ? (
            <div className="field-row">
              <Select
                label={t("network.addJump")}
                value={adding}
                options={[
                  { value: "", label: t("network.chooseHost") },
                  ...hosts
                    .filter((h) => h.id !== hostId && !value.jumpHosts.includes(h.id))
                    .map((h) => ({
                      value: h.id,
                      label: `${h.name} · ${h.username}@${h.host}:${h.port}`,
                    })),
                ]}
                onChange={setAdding}
              />
              <Button
                size="sm"
                disabled={!adding}
                onClick={() => {
                  onChange({ ...value, jumpHosts: [...value.jumpHosts, adding] });
                  setAdding("");
                }}
              >
                {t("common.add")}
              </Button>
            </div>
          ) : null}
        </Field>
      </div>
    </details>
  );
}
