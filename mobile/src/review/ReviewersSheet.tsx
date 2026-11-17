/*
 * Reviewers on one pull request: who has been asked, and who else could be.
 *
 * The candidates are the repository's collaborators (`/prs/mentions`), and the
 * people already asked are drawn from the detail — including a team or someone
 * who has left, so a request can still be taken back. A person's verdict is
 * read from the same roster the Overview draws (`reviewerRows`), which is why
 * this screen and that card cannot disagree about who approved.
 *
 * Each row asks or removes ONE person as it is pressed (mock 53): a request is
 * one notification, so there is nothing to batch and nothing to confirm.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import type { PrDetail } from "../../../shared/types.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { findReviewers, reviewerChoices, reviewersOf } from "../model/prManage.ts";
import { reviewerRows } from "../model/prOverview.ts";
import { Btn, Chip, Eyebrow, Note, Sheet, TAP } from "../ui.tsx";
import { ago } from "../model/cardStatus.ts";
import type { Tone } from "../model/prLook.ts";
import { C, SPACE, T } from "../theme.ts";
import { Avatar } from "../Avatar.tsx";

export function ReviewersSheet({ open, onClose, host, root, detail, mayWrite, blocked, onSaved }: {
  open: boolean;
  onClose: () => void;
  host: Host | null;
  root: string;
  detail: PrDetail;
  mayWrite: boolean;
  blocked: string | null;
  onSaved: () => void;
}): React.ReactNode {
  const current = useMemo(() => reviewersOf(detail), [detail]);
  /** What each person last said, and when: "approved 1 h ago" is the mock's
   *  line under a name (53), and the verdict word alone loses the "when". */
  const said = useMemo(() => {
    const map = new Map<string, { chip: string; tone: Tone; said: string; at?: number }>();
    for (const row of reviewerRows(detail)) {
      if (!row.bot) map.set(row.login.toLowerCase(), { chip: row.chip, tone: row.tone, said: row.said, at: row.at });
    }
    return map;
  }, [detail]);

  const [people, setPeople] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>(current);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const currentKey = current.join("\u0000");
  useEffect(() => {
    if (!open) return;
    setPicked(current);
    setText("");
    setErr(null);
    if (!host) return;
    let gone = false;
    setLoading(true);
    void (async () => {
      const answer = await ask<{ ok: boolean; data?: { users?: string[] }; error?: string }>(
        host, `/prs/mentions?root=${encodeURIComponent(root)}`,
      );
      if (gone) return;
      setLoading(false);
      if (!answer.ok) { setReadErr(answer.error); return; }
      if (!answer.value.ok) { setReadErr(answer.value.error ?? "The repository's people could not be read."); return; }
      setReadErr(null);
      setPeople(answer.value.data?.users ?? []);
    })();
    return () => { gone = true; };
  }, [open, host, root, currentKey]);

  const choices = reviewerChoices(people, current);
  const shown = findReviewers(choices, text);
  /** Already on the pull request (asked, approved, or a team), and everyone
   *  else the search leaves. Asked first, because that is who the screen is
   *  about; a person asked with no verdict yet still counts as asked. */
  const asked = shown.filter((r) => picked.includes(r.login));
  const others = shown.filter((r) => !picked.includes(r.login));
  const now = Date.now();

  const act = useCallback(async (login: string, remove: boolean): Promise<void> => {
    if (!host || !mayWrite || busy) return;
    setBusy(true);
    setErr(null);
    const answer = await ask<{ ok: boolean; error?: string }>(host, "/prs/reviewers", {
      method: "POST",
      body: { root, number: detail.number, add: remove ? [] : [login], remove: remove ? [login] : [] },
    });
    setBusy(false);
    if (!answer.ok) { setErr(answer.error); return; }
    if (!answer.value.ok) { setErr(answer.value.error ?? "GitHub refused that review request."); return; }
    // One person at a time, as the mock draws them: the row says what happened
    // and the card behind the sheet is re-read.
    setPicked((was) => (remove ? was.filter((l) => l !== login) : [...was, login]));
    onSaved();
  }, [host, mayWrite, busy, root, detail.number, onSaved]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Reviewers on #${detail.number}`}
      subtitle={blocked ?? "A review request is one notification, not a new review."}
      tall
      footer={<Btn label="Done" onPress={onClose} style={{ flex: 1 }} />}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder="Find a person"
        placeholderTextColor={C.text4}
        accessibilityLabel="Find a person"
        style={{
          minHeight: 48, borderRadius: 22, borderWidth: 1, borderColor: C.border2,
          backgroundColor: C.bg2, color: C.text, fontSize: T.body, paddingHorizontal: SPACE.lg,
          marginVertical: SPACE.sm,
        }}
      />

      {loading && !choices.length ? (
        <View style={{ padding: SPACE.lg, alignItems: "center" }}><ActivityIndicator color={C.text3} /></View>
      ) : null}
      {readErr ? (
        <View style={{ paddingBottom: SPACE.sm }}>
          <Note tone="bad">
            The repository's people could not be read ({readErr}). The reviewers already asked are still drawn.
          </Note>
        </View>
      ) : null}

      {shown.length ? (
        <View style={{ paddingTop: SPACE.xs }}>
          {asked.map((row) => (
            <ReviewerLine
              key={row.login}
              login={row.login}
              asked
              said={said.get(row.login.toLowerCase())}
              now={now}
              mayWrite={mayWrite}
              busy={busy}
              onAct={act}
            />
          ))}
          {/* The mock's second list (53): the people this pull request has not
              asked. The heading is what separates "who has it" from "who
              could", and both draw the same row. */}
          {others.length ? (
            <View style={{ paddingTop: SPACE.md }}>
              <Eyebrow text="Ask someone else" />
            </View>
          ) : null}
          {others.map((row) => (
            <ReviewerLine
              key={row.login}
              login={row.login}
              asked={false}
              now={now}
              mayWrite={mayWrite}
              busy={busy}
              onAct={act}
            />
          ))}
        </View>
      ) : (
        <View style={{ paddingVertical: SPACE.md }}>
          <Note>{text.trim() ? `Nobody matches “${text.trim()}”.` : "No collaborators were found for this repository."}</Note>
        </View>
      )}

      <View style={{ paddingTop: SPACE.md }}>
        <Note>
          <Text style={{ fontWeight: "700", color: C.text2 }}>Requesting does not take ana’s approval away.</Text>
          {" "}It asks GitHub to put the pull request in someone else's queue; a removal clears the request and
          leaves the review on the conversation.
        </Note>
      </View>
      {err ? <View style={{ paddingTop: SPACE.sm }}><Note tone="bad">{err}</Note></View> : null}
    </Sheet>
  );
}

/** One person (mock 53): the face, the name over what they last said, and the
 *  one control that person takes — a verdict chip once they have spoken, and
 *  Request or Remove before that. */
function ReviewerLine({ login, asked, said, now, mayWrite, busy, onAct }: {
  login: string;
  asked: boolean;
  said?: { chip: string; tone: Tone; said: string; at?: number };
  now: number;
  mayWrite: boolean;
  busy: boolean;
  onAct: (login: string, remove: boolean) => Promise<void>;
}): React.ReactNode {
  const line = said
    ? `${said.said}${said.at ? ` ${ago(said.at, now)}` : ""}`
    : asked ? "asked, no answer yet" : "not asked";
  return (
    <View style={{
      minHeight: 64, flexDirection: "row", alignItems: "center", gap: SPACE.md,
      paddingVertical: SPACE.sm,
    }}>
      <Avatar name={login} login={login} size={34} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: 14.5, fontWeight: "600" }}>{login}</Text>
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{line}</Text>
      </View>
      {said ? (
        <Chip label={said.chip} tone={said.tone} />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${asked ? "Remove" : "Request"} ${login}`}
          disabled={!mayWrite || busy}
          onPress={() => { void onAct(login, asked); }}
          style={({ pressed }) => ({
            minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.md, borderRadius: 12,
            borderWidth: 1, borderColor: C.border, opacity: !mayWrite ? 0.45 : pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: C.text, fontSize: 14, fontWeight: "700" }}>{asked ? "Remove" : "Request"}</Text>
        </Pressable>
      )}
    </View>
  );
}
