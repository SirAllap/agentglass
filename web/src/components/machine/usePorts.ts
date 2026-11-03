import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { PortsReport } from "../../../../shared/types.ts";
import { sameShown } from "../../lib/machineView.ts";
import { useDockerLive } from "../../lib/useDockerLive.ts";
import { useRefreshOnFocus } from "../../lib/useRefreshOnFocus.ts";

/**
 * The listening sockets: read on open, on window focus, on Refresh, and when
 * Docker says containers or networks changed (a published port is the one kind
 * of listener Docker announces). A process started in a terminal has no event;
 * the next focus or Refresh finds it.
 */
export function usePorts() {
  const [data, setData] = useState<PortsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const load = useCallback(() => {
    setLooking(true);
    // Kept as it was when only the age moved: each answer re-rendered the table for nothing.
    api.machinePorts().then((d) => { setData((prev) => (prev && sameShown(prev, d) ? prev : d)); setError(null); })
      .catch((e) => setError(String(e))).finally(() => setLooking(false));
  }, []);
  useEffect(() => { load(); }, [load]);
  useRefreshOnFocus(true, load);
  useDockerLive(true, {
    onChanged: (scope) => { if (scope === "containers" || scope === "networks") load(); },
    onReconnect: load,
  });
  return { data, error, looking, load };
}
export type PortsState = ReturnType<typeof usePorts>;
