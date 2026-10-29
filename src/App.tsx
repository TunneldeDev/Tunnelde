// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect } from "react";

import { bootstrap } from "@/app/bootstrap";
import { AppShell } from "@/components/layout/AppShell";
import { useSettings } from "@/store/settings";

export function App() {
  const ready = useSettings((state) => state.ready);

  useEffect(() => {
    void bootstrap();
  }, []);

  if (!ready) {
    return (
      <div className="splash">
        <img src="/brand/mark-256.png" width={56} height={56} alt="" />
      </div>
    );
  }

  return <AppShell />;
}
