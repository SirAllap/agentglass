/*
 * Put a pull request on a Jira card.
 *
 * Two halves, and the sheet draws them in the order they answer the question.
 * What the card already names comes first — from the same `/jira/prs?key=` read
 * the card screen makes, so the sheet and the card cannot disagree about what is
 * linked — and under it the one thing a phone can add: an address. A phone
 * cannot search GitHub for "the pull request you mean" better than a paste can
 * say it, and the server (`linkPullRequest`) refuses anything that is not a
 * pull request on a repository it knows, reads the card first so linking twice
 * links once, and writes behind the Jira write switch.
 *
 * Between the two sits the repository's open pull requests, read from the same
 * `/prs/list` route the PR board uses (`model/linkPicks.ts`): tapping a row
 * fills the address, so the common case is one tap and one press. The paste
 * field stays for anything the list does not show.
 *
 * Ceiling: no search of GitHub from the phone, and no title field. The link's
 * title is the address's own `slug#number`, which is what a person recognises.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { CardPr } from "../../../shared/providers.ts";
import type { PrSummary } from "../../../shared/types.ts";
import { ask, askCached } from "../lib/api.ts";
import { linkPicks } from "../model/linkPicks.ts";
import { mainCheckouts } from "../model/prRows.ts";
import type { Host } from "../lib/host.ts";
import { Btn, Field, Note, Sheet, TAP } from "../ui.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

export function LinkPrSheet({ open, onClose, host, cardKey, linked, onLinked }: {
  open: boolean;
  onClose: () => void;
  host: Host;
  cardKey: string;
  /** What the card already names, as the card screen read it. */
  linked: readonly CardPr[];
  /** The canonical address the server kept, so the card can re-read its links. */
  onLinked: (url: string) => void;
}): React.ReactNode {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => { if (open) { setUrl(""); setSaid(null); setBusy(false); } }, [open, cardKey]);

  const [lists, setLists] = useState<readonly (readonly PrSummary[])[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLists(null);
    void (async () => {
      const repos = await askCached<{ repos: { root: string; worktreeOf?: string }[] }>(host, "/git/repos", 30_000);
      if (!repos.ok) { if (live) setLists([]); return; }
      const roots = mainCheckouts(Array.isArray(repos.value.repos) ? repos.value.repos : []).slice(0, 3);
      const got = await Promise.all(roots.map(async (r) => {
        const a = await askCached<{ ok: boolean; prs: PrSummary[] }>(
          host, `/prs/list?root=${encodeURIComponent(r.root)}&filter=all&state=open`, 30_000,
        );
        return a.ok && a.value.ok && Array.isArray(a.value.prs) ? a.value.prs : [];
      }));
      if (live) setLists(got);
    })();
    return () => { live = false; };
  }, [open, host]);
  const picks = useMemo(
    () => linkPicks(lists ?? [], linked.map((p) => p.url)),
    [lists, linked],
  );

  const send = async (): Promise<void> => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setSaid(null);
    const answer = await ask<{ ok: boolean; error?: string; linked?: boolean; url?: string }>(
      host, "/jira/link", { method: "POST", body: { key: cardKey, url: url.trim() } },
    );
    setBusy(false);
    if (!answer.ok) { setSaid(answer.error); return; }
    if (!answer.value.ok) { setSaid(answer.value.error ?? "Jira did not accept that link."); return; }
    onLinked(answer.value.url ?? url.trim());
    onClose();
  };

  const first = linked[0];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Link a pull request"
      subtitle={`${cardKey} · the link shows on the card and on the pull request, both ways.`}
      footer={
        <View style={{ flex: 1 }}>
          <Btn
            label={linkLabel(url, picks, first)}
            tone="primary"
            busy={busy}
            disabled={!url.trim()}
            onPress={() => { void send(); }}
          />
        </View>
      }
    >
      {linked.map((pr) => (
        <View
          key={pr.number}
          accessibilityLabel={`${pr.number} already linked`}
          style={{
            minHeight: TAP + 12, flexDirection: "row", alignItems: "center", gap: SPACE.md,
            paddingVertical: SPACE.sm, borderTopWidth: 1, borderTopColor: C.border,
          }}
        >
          <View style={{
            width: 34, height: 34, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center",
            backgroundColor: C.bg3,
          }}>
            <Glyph name="pr" color={C.text2} size={18} />
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: C.text, fontSize: 14, fontWeight: "600" }}>
              #{pr.number}{pr.title ? ` · ${pr.title}` : ""}
            </Text>
            <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>
              already linked · {pr.state.toLowerCase()}
            </Text>
          </View>
          <Glyph name="check" color={C.primary} size={18} weight={2.6} />
        </View>
      ))}

      {picks.map((p) => {
        const on = url.trim() === p.url;
        return (
          <Pressable
            key={p.url}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={`#${p.number} ${p.title}`}
            onPress={() => setUrl(on ? "" : p.url)}
            style={{
              minHeight: TAP + 12, flexDirection: "row", alignItems: "center", gap: SPACE.md,
              paddingVertical: SPACE.sm, borderTopWidth: 1, borderTopColor: C.border,
            }}
          >
            <View style={{
              width: 34, height: 34, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center",
              backgroundColor: p.tone === "bad" ? tint(C.error, 0.14) : C.bg3,
            }}>
              <Glyph name="pr" color={p.tone === "bad" ? C.error : C.text2} size={18} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text numberOfLines={1} style={{ color: C.text, fontSize: 14, fontWeight: "600" }}>#{p.number} · {p.title}</Text>
              <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{p.detail}</Text>
            </View>
            {on ? <Glyph name="check" color={C.primary} size={18} weight={2.6} /> : null}
          </Pressable>
        );
      })}
      {lists === null ? <Note>Reading the open pull requests…</Note> : null}

      <View style={{ paddingTop: SPACE.md, gap: SPACE.sm }}>
        <Field
          value={url}
          onChangeText={setUrl}
          placeholder="https://github.com/acme/orbit/pull/184"
          kind="code"
          label={linked.length ? "Another pull request" : "Pull request address"}
        />
        <Note>
          Only a pull request anywhere on this computer&apos;s GitHub can be linked. Linking never
          merges and never moves the card.
        </Note>
        {said ? <Note tone="bad">{said}</Note> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={{ height: SPACE.sm }} />
    </Sheet>
  );
}

/** "Link #181" once a row is picked, as the mock's button reads; else the address's own words. */
function linkLabel(url: string, picks: readonly { number: number; url: string }[], first: CardPr | undefined): string {
  const hit = picks.find((p) => p.url === url.trim());
  if (hit) return `Link #${hit.number}`;
  if (url.trim()) return first ? "Link another" : "Link the pull request";
  return first ? `Link #${first.number}` : "Link the pull request";
}
