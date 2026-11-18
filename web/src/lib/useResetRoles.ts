import { useState } from "react";
import { api } from "./api.ts";
import { WORKER_ROLES } from "../../../shared/workerRoles.ts";

/** Put every worker role back on its default CLI and model. One function for
 *  every page that offers it; the first press arms, the second one runs. */
export function useResetRoles() {
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const press = async () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false); setNote(null);
    const rs = await Promise.all(WORKER_ROLES.map((r) =>
      api.workerRoleSave(r.id, r.default.provider, r.default.model).then((x) => x.ok).catch(() => false)));
    setNote(rs.every(Boolean) ? "Every role is back on its default." : "Could not reset every role.");
  };
  return { armed, note, press };
}
