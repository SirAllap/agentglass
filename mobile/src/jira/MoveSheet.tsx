/*
 * The move sheet: where the card goes, the fields that target asks for, what
 * will happen, and then the press.
 *
 * Jira does not set a status; it offers transitions, and a transition may
 * demand fields. The target comes first because that is the decision — "where
 * does this go" — and the fields under it are the cost of that particular
 * target. `model/jiraMove.ts` turns the transition and what has been filled in
 * into a disabled button that names the missing field, and into the exact body
 * the POST sends.
 *
 * ── the two ends are named ───────────────────────────────────────────────
 * "In progress → In review" at the top, in the site's own two words, because a
 * sheet titled "Move ORBIT-1042" that only names the destination makes somebody
 * remember where the card was standing. The card screen opens this sheet with
 * the move it was offering already picked, so the common case is a sheet with
 * one press left in it.
 *
 * A move into a done status holds for 1.4 s (`confirmPolicy.ts`, `jira.done`):
 * it finishes a card other people act on. Every other target is a tap. The
 * button is `HoldButton`, which reads that table itself, so the sheet cannot
 * disagree with the policy.
 */
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { JiraMove, ProviderTask } from "../../../shared/providers.ts";
import type { JiraFieldValue, JiraMoveField } from "../../../shared/jiraMoveFields.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { jiraMoveOutcome, movePlan, requiredFields, type JiraMoveOutcome } from "../model/jiraMove.ts";
import { Avatar } from "../Avatar.tsx";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { Chip, Field, HoldButton, Note, Sheet, Switch, TAP } from "../ui.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

export function MoveSheet({ open, onClose, host, card, moves, initial, onMoved }: {
  open: boolean;
  onClose: () => void;
  host: Host;
  card: ProviderTask;
  moves: readonly JiraMove[];
  /** The move the card screen was offering, already picked when the sheet
   *  opens. Absent: the sheet asks which target first. */
  initial?: JiraMove | null;
  onMoved: (outcome: JiraMoveOutcome) => void;
}): React.ReactNode {
  const key = card.customId ?? card.id;
  const [picked, setPicked] = useState<JiraMove | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // "Comment with the move": off until asked for, and the box shows only then.
  const [withComment, setWithComment] = useState(false);
  const [commentText, setCommentText] = useState("");

  // Each opening starts clean: a target and a reviewer from the last card are
  // not answers about this one.
  useEffect(() => {
    if (!open) return;
    setPicked(initial ?? null); setValues({}); setSaid(null); setBusy(false); setWithComment(false); setCommentText("");
  }, [open, key, initial]);

  const plan = useMemo(() => movePlan(key, card.status, picked, values), [key, card.status, picked, values]);
  const need = requiredFields(picked);

  const choose = (move: JiraMove): void => {
    setPicked(move);
    setValues({});
    setSaid(null);
  };

  const send = async (): Promise<void> => {
    if (!picked || !plan.enabled || busy) return;
    setBusy(true);
    setSaid(null);
    const body: Record<string, unknown> = { key, transitionId: picked.id, updated: card.updated };
    if (plan.check?.ok && Object.keys(plan.check.values).length) body.fields = plan.check.values;
    const answer = await ask<{ ok: boolean; error?: string; conflict?: boolean; task?: ProviderTask; was?: string }>(
      host, "/jira/transition", { method: "POST", body },
    );
    const outcome = jiraMoveOutcome(answer);
    // Busy stays on through the comment below: the hold button is live whenever
    // `busy` is false, and a second release would send the move twice.
    if (outcome.kind === "failed") { setBusy(false); setSaid(outcome.text); return; }
    // The move is done; the comment rides after it, and a comment that fails
    // must not undo or hide a move that went through.
    if (withComment && commentText.trim()) {
      await ask(host, "/jira/comment", { method: "POST", body: { key, text: commentText.trim() } });
    }
    setBusy(false);
    onMoved(outcome);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Move ${key}`}
      subtitle={`From ${card.status || "its status"} on ${card.list ?? "the board"}. ${requiredFieldsLine(picked)}`}
      tall
      footer={
        <View style={{ flex: 1, gap: SPACE.sm }}>
          <HoldButton
            action={picked?.toKind === "done" ? "jira.done" : "jira.move"}
            label={plan.label}
            spoken={`${key} to ${picked?.toStatus ?? "another status"}`}
            disabled={!plan.enabled || busy}
            onConfirm={() => { void send(); }}
            onRelease={(line) => setSaid(line)}
            style={{ minHeight: 48 }}
          />
          {said ? <Note tone="bad">{said}</Note> : null}
        </View>
      }
    >
      <View style={{
        flexDirection: "row", alignItems: "center", justifyContent: "center", gap: SPACE.md,
        paddingVertical: SPACE.md, borderRadius: RADIUS.md, backgroundColor: C.bg3,
      }}>
        <Text style={{ color: C.text2, fontSize: 14, fontWeight: "600" }}>{card.status || "—"}</Text>
        <Text style={{ color: C.text3, fontSize: T.body }}>→</Text>
        <Text style={{ color: picked ? C.primary : C.text3, fontSize: 14, fontWeight: "600" }}>
          {picked?.toStatus ?? "pick a target"}
        </Text>
      </View>

      <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600", paddingTop: SPACE.md, paddingBottom: SPACE.xs }}>
        Where it moves
      </Text>
      <View style={{
        flexDirection: "row", padding: 3, gap: 3, borderRadius: RADIUS.md, backgroundColor: C.bg3,
      }}>
        {moves.map((m) => {
          const on = picked?.id === m.id;
          return (
            <Pressable
              key={m.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`Move to ${m.label}`}
              onPress={() => choose(m)}
              style={({ pressed }) => ({
                flex: 1, minHeight: TAP - 4, alignItems: "center", justifyContent: "center",
                paddingHorizontal: SPACE.sm, borderRadius: RADIUS.sm,
                backgroundColor: on ? C.bg2 : pressed ? C.bg4 : "transparent",
                borderWidth: 1, borderColor: on ? C.border : "transparent",
              })}
            >
              <Text numberOfLines={1} style={{ color: on ? C.text : C.text2, fontSize: T.small, fontWeight: on ? "700" : "600" }}>
                {m.toStatus}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={{ paddingTop: SPACE.md }}>
        <InfoRow
          glyph="check"
          title="Status"
          sub={picked ? requiredFieldsLine(picked) : "Pick a target. Jira names the steps this card has from where it stands."}
          trail={need.length ? <Chip label={`${need.length} required`} tone="warn" /> : null}
        />
        <InfoRow
          glyph="people"
          title="Assignee"
          sub={card.people?.[0]?.name ? `${card.people[0].name} keeps it; change it in the card.` : "Nobody is on it; change that in the card."}
          trail={card.people?.[0]?.name ? <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>{card.people[0].name}</Text> : null}
        />
      </View>

      {(picked?.fields ?? []).map((f) => (
        <FieldRow key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues({ ...values, [f.key]: v })} />
      ))}

      <Pressable
        accessibilityRole="switch"
        accessibilityState={{ checked: withComment }}
        accessibilityLabel="Comment with the move"
        onPress={() => setWithComment(!withComment)}
        style={{ marginTop: SPACE.md }}
      >
        <InfoRow
          glyph="comment"
          title="Comment with the move"
          sub="Optional. It lands as your comment on the card."
          trail={<Switch on={withComment} />}
        />
      </Pressable>
      {withComment ? (
        <Field
          label="Comment with the move"
          value={commentText}
          onChangeText={setCommentText}
          placeholder="What changed, and what to look at…"
          kind="text"
          style={{ minHeight: TAP + 40, textAlignVertical: "top", paddingTop: SPACE.md }}
        />
      ) : null}

      <View style={{ paddingTop: SPACE.md, gap: SPACE.xs }}>
        <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>What will happen</Text>
        {(picked ? plan.effects : []).map((line) => (
          <Text key={line} style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>· {line}</Text>
        ))}
        <Text style={{ color: C.text4, fontSize: T.small, lineHeight: 17 }}>
          {key} leaves its lane and moves to the target lane on the board. Its pull requests and
          comments stay attached, and the computer sees the same move at the same moment.
        </Text>
      </View>
      {picked ? (
        <Text style={{ color: plan.enabled ? C.text3 : C.error, fontSize: T.small, paddingTop: SPACE.md }}>
          {plan.enabled ? "The card, its pull requests and its comments go together." : moveHint(plan.label, plan.why)}
        </Text>
      ) : null}
    </Sheet>
  );
}

/** The line under the sheet while the button is off: "Choose a reviewer to
 *  continue." when a field is missing, the plan's own reason otherwise. */
function moveHint(label: string, why: string | null): string {
  const m = /^Choose (.+)$/.exec(label);
  return m ? `Choose a ${m[1]!.toLowerCase()} to continue.` : (why ?? "Fill the move in to continue.");
}

/** A sheet row in the mock's shape: a 34-point tile, a title and a line under it, and what trails. */
function InfoRow({ glyph, title, sub, trail }: {
  glyph: GlyphName; title: string; sub: string; trail?: React.ReactNode;
}): React.ReactNode {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, minHeight: 56, paddingVertical: SPACE.sm }}>
      <View style={{ width: 34, height: 34, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center", backgroundColor: C.bg3 }}>
        <Glyph name={glyph} color={C.text2} size={17} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: C.text, fontSize: 14, fontWeight: "600" }}>{title}</Text>
        <Text numberOfLines={2} style={{ color: C.text3, fontSize: T.small }}>{sub}</Text>
      </View>
      {trail}
    </View>
  );
}

function requiredFieldsLine(move: JiraMove | null): string {
  if (!move) return "Jira names the steps this card has from where it stands.";
  const need = requiredFields(move);
  return need.length ? `Jira asks for ${need.map((f) => f.name).join(" and ")} before this step.` : "This step asks for nothing.";
}

/** One field of the transition's own screen, drawn in the shape its kind takes. */
function FieldRow({ field, value, onChange }: {
  field: JiraMoveField;
  value: unknown;
  onChange: (v: JiraFieldValue | undefined) => void;
}): React.ReactNode {
  if (field.kind === "option") {
    const people = /reviewer|assignee/i.test(field.name);
    return (
      <View style={{ gap: SPACE.xs, paddingTop: SPACE.md }}>
        <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>{field.name}</Text>
        {(field.choices ?? []).map((c) => {
          const on = value === c.id;
          return (
            <Pressable
              key={c.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={c.name}
              onPress={() => onChange(on ? undefined : c.id)}
              style={({ pressed }) => ({
                minHeight: TAP + 8, flexDirection: "row", alignItems: "center", gap: SPACE.md,
                paddingHorizontal: SPACE.md, borderRadius: RADIUS.sm,
                borderWidth: 1, borderColor: on ? C.primary : C.border,
                backgroundColor: on ? tint(C.primary, 0.14) : pressed ? C.bg3 : C.bg2,
              })}
            >
              {people ? <Avatar name={c.name} /> : (
                <View style={{ width: 34, height: 34, borderRadius: RADIUS.md, alignItems: "center", justifyContent: "center", backgroundColor: C.bg3 }}>
                  <Glyph name="check" color={C.text2} size={17} />
                </View>
              )}
              <Text style={{ flex: 1, color: on ? C.primary : C.text, fontSize: T.body, fontWeight: on ? "600" : "400" }}>{c.name}</Text>
              {on ? <Glyph name="check" color={C.primary} size={15} /> : null}
            </Pressable>
          );
        })}
      </View>
    );
  }
  if (field.kind === "options") {
    const list = Array.isArray(value) ? value : [];
    return (
      <View style={{ gap: SPACE.xs, paddingTop: SPACE.md }}>
        <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600" }}>{field.name}</Text>
        {(field.choices ?? []).map((c) => {
          const on = list.includes(c.id);
          return (
            <Pressable
              key={c.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={c.name}
              onPress={() => onChange(on ? list.filter((x) => x !== c.id) : [...list, c.id])}
              style={({ pressed }) => ({
                minHeight: TAP, justifyContent: "center", paddingHorizontal: SPACE.md, borderRadius: RADIUS.sm,
                borderWidth: 1, borderColor: on ? C.primary : C.border,
                backgroundColor: on ? tint(C.primary, 0.14) : pressed ? C.bg3 : C.bg2,
              })}
            >
              <Text style={{ color: on ? C.primary : C.text, fontSize: T.body, fontWeight: on ? "600" : "400" }}>{c.name}</Text>
            </Pressable>
          );
        })}
      </View>
    );
  }
  if (field.kind === "unsupported") {
    return (
      <View style={{ paddingTop: SPACE.md }}>
        <Note tone="bad">{field.name} cannot be filled in here yet ({field.type ?? "this field"}).</Note>
      </View>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <View style={{ paddingTop: SPACE.md }}>
      <Field
        label={field.name}
        value={text}
        onChangeText={(v) => onChange(v)}
        placeholder={field.kind === "date" ? "2026-11-04" : field.kind === "comment" ? "What changed, and what to look at…" : ""}
        kind="text"
        style={field.kind === "comment" || field.kind === "longtext" ? { minHeight: TAP + 40, textAlignVertical: "top", paddingTop: SPACE.md } : undefined}
      />
      {field.required ? <View style={{ paddingTop: SPACE.xs }}><Note>Required by this step.</Note></View> : null}
    </View>
  );
}
