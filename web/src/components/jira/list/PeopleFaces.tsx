/*
 * The faces of the people on a card, or on an epic's children: up to three, then "+N" with the rest named in its tip.
 * It lives on its own because a row and an epic's head draw the same stack, and two copies would drift.
 */
import { useState } from "react";
import type { ProviderTask } from "../../../../../shared/providers.ts";
import { avatarSrc } from "../../../lib/avatarSrc.ts";
import { chipInk } from "../../../lib/contrast.ts";
import { tipAttr } from "../../../lib/tip.ts";

export type TaskPerson = NonNullable<ProviderTask["people"]>[number];

/** The people on a lane's cards, once each, in the order the cards give them. */
export function peopleOf(cards: readonly ProviderTask[]): TaskPerson[] {
  const out: TaskPerson[] = [];
  const seen = new Set<string>();
  for (const t of cards) for (const p of t.people ?? []) {
    const id = p.key ?? (p.id !== undefined ? String(p.id) : p.name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(p);
  }
  return out;
}

export const SHOWN_FACES = 3;

function Face({ p }: { p: TaskPerson }) {
  const [broken, setBroken] = useState(false);
  const tip = p.me ? `${p.name} (you)` : p.name;
  return (
    <span className="agx-jl-face" data-me={p.me ? "" : undefined} data-tip={tipAttr(tip)}
      style={p.color && !(p.avatar && !broken) ? { background: p.color, color: chipInk(p.color) } : undefined}>
      {p.avatar && !broken
        ? <img src={avatarSrc(p.avatar)} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
        : p.initials}
    </span>
  );
}

/**
 * `focusable` is for a head that is not already a tab stop: a row's own faces must not add one. The stack carries a
 * tip with every name, and a click is the host's own, so it never swallows one.
 */
export function PeopleFaces({ people, focusable = false }: { people: readonly TaskPerson[]; focusable?: boolean }) {
  if (!people.length) return null;
  const names = people.map((p) => p.name).join(", ");
  const rest = people.length - SHOWN_FACES;
  return (
    <span className="agx-jl-stack" data-focus={focusable ? "" : undefined} tabIndex={focusable ? 0 : undefined}
      role={focusable ? "img" : undefined} aria-label={focusable ? `People: ${names}` : undefined}
      data-tip={tipAttr({ name: "People", text: names })}>
      {people.slice(0, SHOWN_FACES).map((p, i) => <Face key={p.key ?? p.id ?? `${p.name}${i}`} p={p} />)}
      {rest > 0 && <span className="more" data-tip={tipAttr({ name: `${rest} more`, text: people.slice(SHOWN_FACES).map((p) => p.name).join(", ") })}>+{rest}</span>}
    </span>
  );
}
