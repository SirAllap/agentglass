/*
 * Who is on this card, chosen in a sheet and written once.
 *
 * The mock's shape, and the reason it is a sheet rather than a row on the card:
 * a Jira board has one assignee, so the choice is one of a list, and the write
 * is the same POST whoever you pick. Tapping a name used to write immediately,
 * which made a mis-tap on a 60-point row a change other people saw; picking and
 * then "Save the assignee" makes the second tap the one that costs something.
 *
 * The people come from `/jira/assignable` — Jira's own answer to who may take
 * THIS card, which is not the same list as the project's members — read when
 * the sheet opens, because most cards are never assigned from here.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { JiraPerson, ProviderTask } from "../../../shared/providers.ts";
import { ask } from "../lib/api.ts";
import type { Host } from "../lib/host.ts";
import { Btn, Note, Sheet, TAP } from "../ui.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";

/** The person already on the card, or null for "nobody". */
function onCard(card: ProviderTask): string | null {
  return card.people?.[0]?.name ?? card.assignees.find((n) => n.trim() !== "") ?? null;
}

export function AssigneeSheet({ open, onClose, host, card, onAssigned, onSaid }: {
  open: boolean;
  onClose: () => void;
  host: Host;
  card: ProviderTask;
  /** The card as the server answered the write. */
  onAssigned: (task: ProviderTask) => void;
  onSaid: (ok: boolean, text: string) => void;
}): React.ReactNode {
  const key = card.customId ?? card.id;
  const current = onCard(card);
  const [people, setPeople] = useState<JiraPerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* `undefined` is "nobody picked yet": the row on the card is the starting
     point, and `null` is the person who picked "Unassigned". */
  const [pick, setPick] = useState<JiraPerson | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setPick(undefined); setBusy(false); setError(null); return; }
    if (!host) return;
    let gone = false;
    setPeople(null);
    void ask<{ ok: boolean; people?: JiraPerson[]; error?: string }>(host, `/jira/assignable?key=${encodeURIComponent(key)}`)
      .then((a) => {
        if (gone) return;
        if (!a.ok) { setError(a.error); setPeople([]); return; }
        setError(a.ok && a.value.ok ? null : a.value.error ?? null);
        setPeople(a.ok && a.value.ok ? a.value.people ?? [] : []);
      });
    return () => { gone = true; };
  }, [open, host, key]);

  const chosen = pick === undefined ? current : pick?.name ?? null;
  const save = async (): Promise<void> => {
    if (!host || busy) return;
    if (!card.updated) { onSaid(false, "This card was read without its stamp. Reload it and try again."); onClose(); return; }
    setBusy(true);
    const answer = await ask<{ ok: boolean; error?: string; task?: ProviderTask }>(
      host, "/jira/assignee", { method: "POST", body: { key, to: pick === undefined ? card.people?.[0]?.key ?? null : pick?.key ?? null, updated: card.updated } },
    );
    setBusy(false);
    if (!answer.ok) { onSaid(false, answer.error); return; }
    if (!answer.value.ok) { onSaid(false, answer.value.error ?? "Jira did not take that person."); return; }
    if (answer.value.task) onAssigned(answer.value.task);
    onClose();
    onSaid(true, chosen ? `Assigned to ${chosen}` : "Unassigned");
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Assignee on ${key}`}
      subtitle="The board updates for everyone at once."
      footer={<View style={{ flex: 1 }}><Btn label="Save the assignee" tone="primary" busy={busy} disabled={pick === undefined} onPress={() => { void save(); }} /></View>}
    >
      {people === null ? <Note>Reading the people who can take this card…</Note> : null}
      {error ? <Note tone="bad">{error}</Note> : null}
      {(people ?? []).map((p) => (
        <AssigneeRow
          key={p.key}
          name={p.name}
          initials={p.name.slice(0, 1).toUpperCase() + (p.name.split(/\s+/)[1]?.slice(0, 1).toUpperCase() ?? "")}
          sub={p.name === current ? "Has it now" : "Assignable to this card"}
          on={p.key === (pick === undefined ? card.people?.[0]?.key : pick?.key)}
          me={card.mine === true && p.name === current}
          onPress={() => setPick(p)}
        />
      ))}
      <AssigneeRow
        name="Unassigned"
        initials="—"
        sub="Back to the sprint's pile"
        on={pick === null || (pick === undefined && !current)}
        onPress={() => setPick(null)}
      />
      {people && !people.length && !error ? <Note>Jira lists nobody who can take this card.</Note> : null}
      <View style={{ paddingTop: SPACE.sm }}>
        <Note>One assignee at a time on this board. Choosing a new one replaces the old, it does not add a second.</Note>
      </View>
    </Sheet>
  );
}

/** One person, as the mock draws them: a big face, the name, the line that says
 *  why they are the one, and the tick in a box. */
function AssigneeRow({ name, initials, sub, on, me, onPress }: {
  name: string;
  initials: string;
  sub: string;
  on: boolean;
  me?: boolean;
  onPress: () => void;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${name}. ${sub}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TAP + 12, flexDirection: "row", alignItems: "center", gap: SPACE.md,
        paddingVertical: SPACE.sm, borderTopWidth: 1, borderTopColor: C.border,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{
        width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center",
        backgroundColor: me ? tint(C.primary, 0.18) : C.bg3,
      }}>
        <Text style={{ color: me ? C.primary : C.text2, fontSize: 12, fontWeight: "700" }}>{initials}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: C.text, fontSize: 15, fontWeight: "600" }}>{name}</Text>
        <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small }}>{sub}</Text>
      </View>
      <View style={{
        width: 26, height: 26, borderRadius: RADIUS.sm, alignItems: "center", justifyContent: "center",
        borderWidth: 1.5, borderColor: on ? C.primary : C.border2, backgroundColor: on ? C.primary : "transparent",
      }}>
        {on ? <Glyph name="check" color={C.bg} size={15} weight={2.6} /> : null}
      </View>
    </Pressable>
  );
}
