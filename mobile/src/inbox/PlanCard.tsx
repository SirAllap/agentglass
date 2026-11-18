/*
 * The Go card: a flight plan that is stopped until somebody decides.
 *
 * It is the one row in the Inbox where the answer is not "go and look" but a
 * press that costs money — Go launches a builder and spends a worker — so it
 * draws what the press will do before the press: the model the builder starts
 * on and why the plan picked it (`shared/builderModel.ts`), and the reason the
 * coordinator stopped, when it did.
 *
 * Go holds (model/confirmPolicy.ts: `plan.go`), because a thumb in a pocket
 * must not launch anything. No-go is a tap, because the safe direction must not
 * be slow. "Read the plan" is a read of one plan — the list route strips the
 * text, so this is the one request the card makes on demand, and it is what
 * somebody does BEFORE deciding.
 *
 * A second press while the first is out is refused here, not by the server:
 * `model/planGo.ts` holds Go's decision and the words it says, and No-go has
 * the card's own pending flag — a second No-go is a second POST.
 */
import { useState } from "react";
import { Text, View } from "react-native";
import type { Host } from "../lib/host.ts";
import { ask } from "../lib/api.ts";
import { WHY_NOT, type InboxItem, type PlanWaiting } from "../model/inbox.ts";
import { answerGone } from "../model/inboxStale.ts";
import { afterGo, launchLine, pressGo, type GoPhase } from "../model/planGo.ts";
import { Md } from "../md/Md.tsx";
import { Btn, Chip, HoldButton, Sheet, toneInk } from "../ui.tsx";
import { C, RADIUS, SPACE, T } from "../theme.ts";

/** One plan, as `/flight-plan/plans/<id>` answers it. Only the text is wanted:
 *  everything else the card draws came from the list. */
interface PlanRead {
  ok?: boolean;
  error?: string;
  plan?: { title?: string; planMd?: string };
}

export function PlanCard({ item, plan, host, onAnswered }: {
  item: InboxItem;
  /** The row's own plan, for the launch line and the size. Absent when the read
   *  that produced the row has been replaced since — the card then draws what
   *  the row itself says and no launch line, rather than a guess. */
  plan?: PlanWaiting;
  host: Host;
  onAnswered: () => void;
}): React.ReactNode {
  const [phase, setPhase] = useState<GoPhase>("ready");
  const [nogo, setNogo] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [text, setText] = useState<{ title: string; md: string } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);

  const openPlan = async (): Promise<void> => {
    setReading(true);
    setReadError(null);
    const answer = await ask<PlanRead>(host, `/flight-plan/plans/${item.action.kind === "plan" ? item.action.id : ""}`);
    setReading(false);
    if (!answer.ok) { setReadError(answer.error); setText(null); return; }
    if (!answer.value.ok || !answer.value.plan) {
      setReadError(answer.value.error || "The computer has no text for this plan.");
      setText(null);
      return;
    }
    setText({ title: answer.value.plan.title || "The plan", md: answer.value.plan.planMd || "" });
  };

  const decide = async (go: boolean): Promise<void> => {
    if (item.action.kind !== "plan") return;
    if (go) {
      const press = pressGo(phase);
      if (!press.post) { setSaid(press.said ?? null); return; }
      setPhase("posting");
    } else {
      if (nogo) return;
      setNogo(true);
    }
    setSaid(null);
    const answer = await ask<{
      ok?: boolean; error?: string; queued?: boolean; launchError?: string; worktree?: string; branch?: string;
    }>(host, `/flight-plan/plans/${item.action.id}/${go ? "go" : "no-go"}`, { method: "POST", body: {} });
    // Decided at the desk first: the card leaves instead of staying with an error.
    if (answerGone("plans", answer)) { setNogo(false); setPhase("ready"); onAnswered(); return; }
    if (!go) {
      setNogo(false);
      if (!answer.ok) { setSaid(answer.error); return; }
      if (!answer.value.ok) { setSaid(answer.value.error || "The plan did not take that."); return; }
      onAnswered();
      return;
    }
    const next = afterGo({
      ok: answer.ok,
      ...(answer.ok
        ? {
          took: !!answer.value.ok,
          error: answer.value.error,
          queued: !!answer.value.queued,
          launchError: answer.value.launchError,
          where: answer.value.branch || answer.value.worktree,
        }
        : { error: answer.error }),
    });
    setPhase(next.phase);
    if (next.said) setSaid(next.said);
    if (next.phase === "sent") onAnswered();
  };

  const stop = typeof plan?.stopReason === "string" ? plan.stopReason : plan?.stopReason?.text;

  return (
    <View
      accessibilityLabel={`Decision: ${item.text}`}
      style={{
        padding: 14, gap: SPACE.sm, borderRadius: RADIUS.lg,
        borderWidth: 1, borderColor: C.border, backgroundColor: C.bg2,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <Chip label="Decision" tone="accent" />
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, flex: 1, textAlign: "right" }}>
          {plan ? [plan.size ?? "M", plan.root.split("/").filter(Boolean).pop()].join(" · ") : item.detail}
        </Text>
      </View>

      <Text numberOfLines={3} style={{ color: C.text, fontSize: 18, fontWeight: "600", lineHeight: 23 }}>
        {plan?.title || item.text.replace(/^Go or No-go: /, "")}
      </Text>

      <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>
        {plan ? launchLine(plan) : "The builder starts on the model this project set for the builder role."}
      </Text>
      {stop ? <Text style={{ color: toneInk("warn"), fontSize: T.small, lineHeight: 18 }}>{stop}</Text> : null}

      {item.canAct ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingTop: SPACE.xs }}>
          <Btn label="Read the plan" onPress={() => { void openPlan(); }} busy={reading} disabled={phase === "posting"} />
          <View style={{ flex: 1 }} />
          <Btn label="No-go" onPress={() => { void decide(false); }} busy={nogo} disabled={phase !== "ready"} />
          <HoldButton
            action="plan.go"
            label={phase === "sent" ? "Go · sent" : "Go"}
            spoken={plan?.title || item.text}
            onConfirm={() => { void decide(true); }}
            onRelease={setSaid}
            disabled={phase !== "ready"}
          />
        </View>
      ) : (
        <Text style={{ color: C.text3, fontSize: T.small, lineHeight: 18 }}>{WHY_NOT.plan}</Text>
      )}

      {said ? (
        <Text accessibilityLiveRegion="polite" style={{ color: phase === "sent" ? toneInk("good") : toneInk("bad"), fontSize: T.small }}>
          {said}
        </Text>
      ) : null}

      <Sheet
        open={reading || text !== null || readError !== null}
        onClose={() => { setText(null); setReadError(null); }}
        title={text?.title || "The plan"}
        subtitle={plan?.root.split("/").filter(Boolean).pop()}
        tall
        footer={<Btn label="Close" onPress={() => { setText(null); setReadError(null); }} style={{ flex: 1 }} />}
      >
        {readError ? (
          <Text style={{ color: toneInk("bad"), fontSize: T.body, lineHeight: 21 }}>{readError}</Text>
        ) : text ? (
          <Md text={text.md} host={host} />
        ) : (
          <Text style={{ color: C.text3, fontSize: T.body }}>Asking the computer for the plan text…</Text>
        )}
      </Sheet>
    </View>
  );
}
