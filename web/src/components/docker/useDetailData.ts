/*
 * What the sections under the log fetch, and only when they are open: `top`
 * shells out to the container and `inspect` returns a few hundred KB, so paying
 * for both every time somebody picks a row to read its log is the wrong trade.
 * Keyed on the container on screen, so a section never shows the previous
 * container's environment for the moment before the new one arrives.
 */
import { useEffect, useState } from "react";
import { api } from "../../lib/api.ts";
import type { DetailSection } from "./Detail.tsx";

export function useDetailData(id: string | undefined, open: Record<DetailSection, boolean>) {
  const [env, setEnv] = useState<string[] | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  const [top, setTop] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setEnv(null); setConfig(null); setTop(null); setError(null); }, [id]);
  useEffect(() => {
    if (!id) return;
    let live = true;
    if ((open.env || open.config) && !(env && config)) {
      void api.dockerInspect(id).then((r) => {
        if (!live) return;
        if (!r.ok) { setError(r.error || "docker inspect failed"); return; }
        setEnv(r.env); setConfig(r.config); setError(null);
      });
    }
    if (open.top && top == null) {
      void api.dockerTop(id).then((r) => {
        if (!live) return;
        if (!r.ok) { setError(r.error || "Not running"); setTop(null); return; }
        setTop(r.text); setError(null);
      });
    }
    return () => { live = false; };
  }, [id, open.env, open.config, open.top, env, config, top]);

  return { env, config, top, error };
}
