/*
 * The GitHub-login → Jira-account pairs this machine learned, in Settings > Jira,
 * so the person can see what a picker will offer first and take one away.
 *
 * A pair is made only by doing both picks on one card (prCardPeople.ts explains
 * why a name or an email is never enough). Reading and removing here are local:
 * nothing on this list is written to Jira or GitHub.
 */
import { useEffect, useState } from "react";
import { Button } from "../workspace/Chrome.tsx";
import { ICON } from "../../lib/iconSize.ts";
import { CrossIcon, UserIcon } from "../../lib/glyphIcons.tsx";
import { SettingsCard } from "../SettingsKit.tsx";
import { forgetPair, loadPairs, type JiraPair } from "../../lib/jiraPairs.ts";

export function JiraPairList() {
  const [pairs, setPairs] = useState<JiraPair[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { let live = true; void loadPairs().then((p) => { if (live) setPairs(p); }); return () => { live = false; }; }, []);
  // Drawn before the read answers and with nothing learned: the card is how a
  // person finds out the feature exists before its first pair.
  const list = pairs ?? [];
  const remove = async (login: string) => {
    setBusy(login);
    const left = await forgetPair(login).catch(() => list);
    setBusy(null);
    setPairs(left);
  };
  return (
    <div data-jira-pairs="">
    <SettingsCard title="GitHub reviewers on Jira" icon={<UserIcon size={ICON.sm} />}
      desc="When you pick a reviewer and a Jira assignee together, the pair is kept here and that account is offered first next time. Nothing is assigned on its own, and nothing here is written to Jira or GitHub.">
      {list.length === 0 ? (
        <p className="text-[12px] m-0" style={{ color: "var(--text3)" }}>
          No pairs learned yet. They appear after you pick a reviewer and a Jira assignee together.
        </p>
      ) : (
        <div className="flex flex-col gap-1" role="list" aria-label="GitHub logins learned as Jira accounts">
          {list.map((p) => (
            <div key={p.login} role="listitem" className="flex items-center gap-2 text-[12px] min-w-0 rounded-lg px-2 py-1" style={{ background: "var(--surface-inset)" }}>
              <b className="shrink-0" style={{ color: "var(--text)" }}>{p.login}</b>
              <span className="min-w-0 break-words" style={{ color: "var(--text2)" }}>{p.name}{p.email ? ` · ${p.email}` : ""}</span>
              <Button size="compact" className="ml-auto shrink-0" disabled={busy === p.login} onClick={() => { void remove(p.login); }}
                data-tip={`Forget that ${p.login} is ${p.name}`} aria-label={`Remove the pair for ${p.login}`}><CrossIcon size={ICON.xs} /></Button>
            </div>
          ))}
        </div>
      )}
    </SettingsCard>
    </div>
  );
}
