import { useEffect, useRef } from "react";
import { api } from "./api.ts";
import { connectDockerLive, type DockerLiveHandlers } from "./dockerLive.ts";

/**
 * Hold the Docker feed open while `active`: the panel hears that a list
 * changed instead of asking every few seconds. Handlers may be inline closures.
 */
export function useDockerLive(active: boolean, handlers: DockerLiveHandlers): void {
  const saved = useRef(handlers);
  saved.current = handlers;
  useEffect(() => {
    if (!active) return;
    return connectDockerLive(api.dockerLiveUrl(), () => saved.current);
  }, [active]);
}
