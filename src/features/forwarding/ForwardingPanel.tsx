import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ForwardingSection, type ForwardRule } from "./ForwardingSection";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import "./forwarding-panel.css";

interface ForwardStatus extends ForwardRule {
  active: boolean;
}
export function ForwardingPanel() {
  const { t } = useTranslation();
  const hosts = useHosts((state) => state.hosts);
  const sessions = useSsh((state) => state.sessions);
  const [selected, setSelected] = useState<string | null>(null);
  const [rules, setRules] = useState<ForwardStatus[]>([]);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const load = useCallback(() => {
    if (!isTauri()) return;
    const request = ++generation.current;
    void invoke<ForwardStatus[]>("forwarding_list").then(
      (rows) => {
        if (generation.current === request) {
          setRules(rows);
          setError("");
        }
      },
      (cause: unknown) => {
        if (generation.current === request) setError(translateError(cause));
      },
    );
  }, []);
  useEffect(() => {
    const requests = generation;
    load();
    window.addEventListener("tunnelde:forwarding-changed", load);
    return () => {
      requests.current++;
      window.removeEventListener("tunnelde:forwarding-changed", load);
    };
  }, [load, sessions]);
  return (
    <div className="forwarding-panel">
      <header className="forwarding-panel__header">{t("forward.title")}</header>
      <div className="forwarding-panel__content">
        {error && <p role="alert">{error}</p>}
        {hosts.map((host) => {
          const own = rules.filter((rule) => rule.hostId === host.id);
          const active = own.filter((rule) => rule.active).length;
          return (
            <div key={host.id} className="forwarding-panel__host">
              <button
                type="button"
                className="forwarding-panel__host-button"
                aria-expanded={selected === host.id}
                onClick={() => setSelected(selected === host.id ? null : host.id)}
              >
                <span>{host.name}</span>
                <small>
                  {active}/{own.length} {t("forward.running")}
                </small>
              </button>
              {selected === host.id && <ForwardingSection host={host} embedded />}
            </div>
          );
        })}
        {!hosts.length && <p>{t("sidebar.empty")}</p>}
      </div>
    </div>
  );
}
