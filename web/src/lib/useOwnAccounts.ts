import { useEffect, useState } from "react";
import { api } from "./api.ts";
import type { UsageAccount } from "../../../shared/usageAccounts.ts";

/** The accounts added here, read once when a form opens; empty until they arrive or when the server cannot say. */
export function useOwnAccounts(): UsageAccount[] {
  const [list, setList] = useState<UsageAccount[]>([]);
  useEffect(() => { void api.ownAccounts().then((r) => setList(r.accounts ?? [])).catch(() => setList([])); }, []);
  return list;
}
