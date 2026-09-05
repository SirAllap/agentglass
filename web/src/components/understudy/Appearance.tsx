/*
 * What the understudy looks like — and what it has not earned the right to
 * wear yet.
 *
 * It lives in Settings → Understudy, beside the portrait it changes, and NOT
 * in the understudy view: the view is a scorecard, and eleven rows of chips
 * under a scorecard pushed the seals — the part worth reading — off the
 * bottom of a 1080px screen. The view wears the face; this is where the face
 * is chosen. Both read the same store (`persona/cosmeticStore.ts`), so a pick
 * here is on the portrait in the view before the dialog closes.
 *
 * TWO THINGS ARE DELIBERATE HERE AND BOTH WILL LOOK LIKE OMISSIONS.
 *
 * 1. A LOCKED COSMETIC IS LOCKED BY THE SERVER, not by this file. Every closed
 *    option names a decision class, and whether it is closed is that class's
 *    `offered` flag off the scorecard — the same flag the capability rows are
 *    drawn from. The reason shown to the user is the sentence the SERVER wrote
 *    for that class, printed verbatim. There is no second rule here, no time
 *    served, no threshold: a cosmetic that could open on its own would be a
 *    second opinion about what has been earned, and the first thing anybody
 *    would do with it is discover the two disagree.
 *
 * 2. THE COLOURS ARE NOT THEME TOKENS AND NOT WRITTEN HERE. A skin, a hair, a
 *    jacket is ART — a swatch from `persona/swatches.ts`, which is where the
 *    hexes live and the only place they are allowed to (see
 *    web/test/understudy-panel-tokens.test.ts). This file paints a swatch chip
 *    with a value it was handed, never with a literal of its own.
 */
import type { CSSProperties } from "react";
import type { UnderstudyClassRow } from "../../../../shared/types.ts";
import { Chip } from "../workspace/Chrome.tsx";
import { edge, wash } from "../git/ui.tsx";
import { ICON } from "../../lib/iconSize.ts";
import {
  BEARDS, BODIES, BROWS, DEFAULT_COSMETIC, EARS, EYES, EYEWEAR, HAIRSTYLES, HEADWEAR, HORNS,
  MOUTHS, NECKWEAR, NOSES, OUTFITS, PRESETS, applyPreset,
  type Cosmetic, type Option, type Palette,
} from "./persona/parts.ts";
import { NATURAL_LIPS, SWATCHES, swatch, type Swatch, type SwatchKind } from "./persona/swatches.ts";
import { Persona } from "./persona/Persona.tsx";

export { loadCosmetic, saveCosmetic } from "./persona/cosmeticStore.ts";

/* ---------------------------------------------------------------- the locks */

interface Earned {
  /** `slot:id` — the option this closes. */
  key: string;
  name: string;
  /** The class on the scorecard that decides it. */
  cls: string;
}

/**
 * Four options that open on the same measurement the capabilities do.
 *
 * The pairing is a joke with a point to it: each one dresses the understudy for
 * the job it has just been judged competent at, so an unlocked cosmetic is a
 * thing you can SEE about the scorecard from across the room. Which four is a
 * design choice; whether they are open is not.
 */
const EARNED: readonly Earned[] = [
  { key: "neckwear:tie", name: "Worktree tie", cls: "C1" },
  { key: "outfit:male04", name: "Landing jacket", cls: "C3" },
  { key: "eyewear:monocle", name: "Reviewer's monocle", cls: "C10" },
  { key: "ears:fox_ears01", name: "Night-shift fox", cls: "C13" },
];

/**
 * Three it will never wear, and one sentence for all three.
 *
 * They have no art behind them on purpose — there is nothing to draw, because
 * these are insignia of an authority the understudy does not have and is not
 * going to be given. The reason under them is the sealed class's own sentence
 * off the scorecard, because it is the same reason: the thing they depict is
 * somebody else's record of the work, somebody else's name on a push, somebody
 * else's conversation.
 */
const INSIGNIA = [
  { id: "quill", label: "Quill", what: "writing on somebody else's record of the work" },
  { id: "signet", label: "Signet", what: "pushing under your name" },
  { id: "mask", label: "Mask", what: "speaking to a person as you" },
] as const;

function Padlock() {
  return (
    <svg width={ICON.xs} height={ICON.xs} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

type Lock = { name: string; why: string } | null;

/**
 * How many options are still shut, for a count beside the section.
 *
 * The SEALED three are not in it, and that is the point rather than an
 * omission: they are not waiting for anything, so counting them alongside the
 * ones that open would put a number on the header that never goes down.
 *
 * Exported rather than counted by the caller, because the manifest that
 * decides it lives here: a header that counted them itself would be a second
 * place that knows which cosmetics are locked.
 */
export function closedCount(classes: readonly UnderstudyClassRow[]): number {
  return EARNED.filter((e) => {
    const cls = classes.find((c) => c.id === e.cls);
    return !cls || !cls.offered;
  }).length;
}

/* --------------------------------------------------------------- the rows */

type Pick = string | null;

/** The label column of a row. Shared by every kind of row so they line up. */
function Label({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="min-w-0">
      <span className="block text-[11.5px]" style={{ color: "var(--text)" }}>{label}</span>
      {hint && <span className="block text-[10px] mt-1" style={{ color: "var(--text4)" }}>{hint}</span>}
    </span>
  );
}

function OptionRow({ label, hint, value, options, optional, onPick, lockedKey, lockOf }: {
  label: string;
  hint?: string;
  value: Pick;
  options: readonly Option[];
  /** Whether "None" is one of the answers — a beard is, a nose is not. */
  optional?: boolean;
  onPick: (v: Pick) => void;
  /** The slot name this row writes, for matching against the lock manifest. */
  lockedKey: string;
  lockOf: (key: string) => Lock;
}) {
  const all: { id: Pick; label: string }[] = [
    ...(optional ? [{ id: null as Pick, label: "None" }] : []),
    ...options.map((o) => ({ id: o.id as Pick, label: o.label })),
  ];
  return (
    <div className="agx-settings-row items-start" style={{ gridTemplateColumns: "minmax(0, 120px) minmax(0, 1fr)" }}>
      <Label label={label} hint={hint} />
      <span className="flex flex-wrap gap-1 justify-self-stretch">
        {all.map((o) => {
          const lock = o.id === null ? null : lockOf(`${lockedKey}:${o.id}`);
          return (
            <Chip
              key={o.id ?? "none"}
              on={value === o.id}
              disabled={!!lock}
              onClick={lock ? undefined : () => onPick(o.id)}
              title={lock ? `${lock.name} — ${lock.why}` : undefined}
              className="inline-flex items-center gap-1"
              style={lock ? { color: "var(--text4)" } : undefined}
            >
              {lock && <Padlock />}
              {o.label}
            </Chip>
          );
        })}
      </span>
    </div>
  );
}

/**
 * A colour: one round chip per swatch, painted with the swatch's own colour.
 *
 * 22px, not the row's 11px type: the icon-size rule applies to anything that
 * is only a shape, and a colour you have to squint at is a colour you cannot
 * choose. The chosen one gets the theme's focus ring, which is the only
 * theme colour in the row — the fills are art and come in with the swatch.
 */
function SwatchRow({ label, hint, kind, value, onPick, chipFor }: {
  label: string;
  hint?: string;
  kind: SwatchKind;
  value: string;
  onPick: (id: string) => void;
  /** The colour to paint a chip, when it is not the swatch's own — natural lips are the skin's. */
  chipFor?: (s: Swatch) => string;
}) {
  const list = SWATCHES[kind];
  return (
    <div className="agx-settings-row items-start" style={{ gridTemplateColumns: "minmax(0, 120px) minmax(0, 1fr)" }}>
      <Label label={label} hint={hint} />
      <span className="flex flex-wrap gap-1.5 justify-self-stretch" role="radiogroup" aria-label={label}>
        {list.map((s) => {
          const on = s.id === value;
          const colour = chipFor?.(s) ?? s.chip;   // art, resolved from the swatch
          const style: CSSProperties = {
            width: 22,
            height: 22,
            borderRadius: 999,
            background: colour,
            border: `1px solid ${on ? "var(--primary)" : "transparent"}`,
            boxShadow: on ? `0 0 0 2px var(--bg), 0 0 0 4px var(--primary)` : `inset 0 0 0 1px ${wash("--text", 18)}`,
            cursor: "pointer",
            flex: "0 0 auto",
          };
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={s.label}
              title={s.label}
              onClick={() => onPick(s.id)}
              style={style}
            />
          );
        })}
      </span>
    </div>
  );
}

/**
 * Somewhere to start: a whole person per card, the portrait drawn live.
 *
 * The cards are portraits and not names, because a name tells you nothing
 * about a face. 96px is the art's native size — the one size that needs no
 * resampling — and twelve of them wrap to two rows in the settings column.
 */
function Presets({ onPick }: { onPick: (c: Cosmetic) => void }) {
  return (
    <div className="px-4 pt-3 pb-2">
      <div className="text-[11.5px] mb-2" style={{ color: "var(--text)" }}>Start from</div>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => {
          const cos = applyPreset(p);
          return (
            <button
              key={p.id}
              type="button"
              title={p.label}
              onClick={() => onPick(cos)}
              className="flex flex-col items-center gap-1 rounded-lg p-1.5"
              style={{ background: wash("--text", 4), border: edge(8), cursor: "pointer" }}
            >
              <Persona px={96} cos={cos} label={p.label} />
              <span className="text-[10px]" style={{ color: "var(--text3)" }}>{p.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A thin rule with a word on it, between groups of rows. */
function Group({ title }: { title: string }) {
  return (
    <div className="px-4 pt-4 pb-1 text-[10px] uppercase tracking-wider" style={{ color: "var(--text4)" }}>
      {title}
    </div>
  );
}

export function Appearance({ value, onChange, classes }: {
  value: Cosmetic;
  onChange: (next: Cosmetic) => void;
  /** The scorecard's own rows. The ONLY authority on what is open. */
  classes: readonly UnderstudyClassRow[];
}) {
  const rowOf = (id: string): UnderstudyClassRow | undefined => classes.find((c) => c.id === id);

  const lockOf = (key: string): Lock => {
    const e = EARNED.find((x) => x.key === key);
    if (!e) return null;
    const cls = rowOf(e.cls);
    // No scorecard yet is not the same as unlocked. Until a frame arrives the
    // honest answer is "we do not know", and the honest drawing of that is the
    // closed one — an option that opens for a second on a slow socket and then
    // shuts is worse than one that never blinked.
    if (!cls) return { name: e.name, why: `Waiting for ${e.cls}'s row on the scorecard.` };
    if (cls.offered) return null;
    return { name: e.name, why: cls.blocked[0] ?? `${e.cls} has not met its measurement yet.` };
  };

  const byReason = [...EARNED.reduce((m, e) => {
    const lock = lockOf(e.key);
    if (!lock) return m;
    m.set(lock.why, [...(m.get(lock.why) ?? []), e.name]);
    return m;
  }, new Map<string, string[]>())];
  const sealedRow = classes.find((c) => c.lock === "sealed");
  const sealedWhy = sealedRow?.blocked[0]
    ?? "Sealed by decision rather than by score — the scorecard has not arrived to say so in its own words yet.";

  const set = (patch: Partial<Cosmetic>) => onChange({ ...value, ...patch });
  const paint = (patch: Partial<Palette>) => onChange({ ...value, colors: { ...value.colors, ...patch } });

  /*
   * A preset may name a locked option — the fox ears, the jacket. Applying
   * one must not hand over something the scorecard has not opened, so each
   * locked slot is set back to the default's answer for it. The rest of the
   * preset goes through; what was refused is visible as the chip still shut.
   */
  const pickPreset = (cos: Cosmetic) => {
    const next = { ...cos };
    if (lockOf(`neckwear:${next.neckwear}`)) next.neckwear = DEFAULT_COSMETIC.neckwear;
    if (lockOf(`outfit:${next.outfit}`)) next.outfit = DEFAULT_COSMETIC.outfit;
    if (lockOf(`eyewear:${next.eyewear}`)) next.eyewear = DEFAULT_COSMETIC.eyewear;
    if (lockOf(`ears:${next.ears}`)) next.ears = DEFAULT_COSMETIC.ears;
    onChange(next);
  };

  const skin = swatch("skin", value.colors.skin).tones;
  const lipChip = (s: Swatch) => (s.id === NATURAL_LIPS ? skin.dark : s.chip);

  return (
    <div className="agx-settings-col">
      <Presets onPick={pickPreset} />

      <div className="agx-settings-rows">
        <Group title="Head" />
        <OptionRow label="Face" value={value.body} options={BODIES} lockedKey="body" lockOf={lockOf}
          onPick={(v) => set({ body: v ?? DEFAULT_COSMETIC.body })} />
        <SwatchRow label="Skin" kind="skin" value={value.colors.skin} onPick={(skin) => paint({ skin })} />
        <OptionRow label="Hair" value={value.hair} options={HAIRSTYLES} lockedKey="hair" lockOf={lockOf}
          onPick={(v) => set({ hair: v ?? DEFAULT_COSMETIC.hair })} />
        <SwatchRow label="Hair colour" kind="hair" value={value.colors.hair} onPick={(hair) => paint({ hair })} />

        <Group title="Face" />
        <OptionRow label="Eyes" value={value.eyes} options={EYES} lockedKey="eyes" lockOf={lockOf}
          onPick={(v) => set({ eyes: v ?? DEFAULT_COSMETIC.eyes })} />
        <SwatchRow label="Eye colour" kind="iris" value={value.colors.iris} onPick={(iris) => paint({ iris })} />
        <OptionRow label="Brows" value={value.brows} options={BROWS} lockedKey="brows" lockOf={lockOf}
          onPick={(v) => set({ brows: v ?? DEFAULT_COSMETIC.brows })} />
        <OptionRow label="Nose" value={value.nose} options={NOSES} lockedKey="nose" lockOf={lockOf}
          onPick={(v) => set({ nose: v ?? DEFAULT_COSMETIC.nose })} />
        <OptionRow label="Mouth" value={value.mouth} options={MOUTHS} lockedKey="mouth" lockOf={lockOf}
          onPick={(v) => set({ mouth: v ?? DEFAULT_COSMETIC.mouth })} />
        <SwatchRow label="Lips" hint="Natural is the skin's own shade." kind="lips" value={value.colors.lips}
          onPick={(lips) => paint({ lips })} chipFor={lipChip} />
        <OptionRow label="Beard" value={value.beard} options={BEARDS} optional lockedKey="beard" lockOf={lockOf}
          onPick={(v) => set({ beard: v })} />

        <Group title="Wear" />
        <OptionRow label="Outfit" value={value.outfit} options={OUTFITS} lockedKey="outfit" lockOf={lockOf}
          onPick={(v) => set({ outfit: v ?? DEFAULT_COSMETIC.outfit })} />
        <SwatchRow label="Cloth" kind="cloth" value={value.colors.cloth1} onPick={(cloth1) => paint({ cloth1 })} />
        <SwatchRow label="Lining" hint="The second colour of a garment that has one." kind="cloth" value={value.colors.cloth2}
          onPick={(cloth2) => paint({ cloth2 })} />
        <SwatchRow label="Trim" hint="Piping, a pendant, a ribbon, a scarf." kind="cloth" value={value.colors.cloth3}
          onPick={(cloth3) => paint({ cloth3 })} />
        <OptionRow label="Neckwear" value={value.neckwear} options={NECKWEAR} optional lockedKey="neckwear" lockOf={lockOf}
          onPick={(v) => set({ neckwear: v })} />
        <OptionRow label="Eyewear" value={value.eyewear} options={EYEWEAR} optional lockedKey="eyewear" lockOf={lockOf}
          onPick={(v) => set({ eyewear: v })} />
        <SwatchRow label="Metal" hint="Frames, a headset, earrings, horn." kind="metal" value={value.colors.metal}
          onPick={(metal) => paint({ metal })} />

        <Group title="Extras" />
        <OptionRow label="Headwear" value={value.headwear} options={HEADWEAR} optional lockedKey="headwear" lockOf={lockOf}
          onPick={(v) => set({ headwear: v })} />
        <OptionRow label="Ears" hint="Worn on top of the head, over the hair — which is why they are visible at all."
          value={value.ears} options={EARS} optional lockedKey="ears" lockOf={lockOf}
          onPick={(v) => set({ ears: v })} />
        <OptionRow label="Horns" value={value.horns} options={HORNS} optional lockedKey="horns" lockOf={lockOf}
          onPick={(v) => set({ horns: v })} />

        <div className="agx-settings-row items-start" style={{ gridTemplateColumns: "minmax(0, 120px) minmax(0, 1fr)" }}>
          <Label label="Hair clip" hint="Where the style has somewhere to put one." />
          <span className="flex flex-wrap gap-1 justify-self-stretch">
            {[false, true].map((on) => (
              <Chip key={String(on)} on={value.hairDecoration === on} onClick={() => set({ hairDecoration: on })}>
                {on ? "Clip" : "None"}
              </Chip>
            ))}
          </span>
        </div>

        {/* The three it will never wear. Spans, not disabled buttons: a
            control that can never be operated is not a control, and drawing
            one is how a UI ends up promising something it has to take back. */}
        <div className="agx-settings-row items-start" style={{ gridTemplateColumns: "minmax(0, 120px) minmax(0, 1fr)" }}>
          <Label label="Insignia" hint={`Three it will never wear. ${sealedWhy}`} />
          <span className="flex flex-wrap gap-1 justify-self-stretch">
            {INSIGNIA.map((i) => (
              <span
                key={i.id}
                title={`Sealed — ${i.what}. ${sealedWhy}`}
                className="text-[11.5px] px-2 py-1 rounded-lg whitespace-nowrap inline-flex items-center gap-1"
                style={{ color: "var(--error)", background: wash("--error", 8), border: `1px solid ${wash("--error", 26)}` }}
              >
                <Padlock />
                {i.label}
              </span>
            ))}
          </span>
        </div>
      </div>

      {byReason.length > 0 && (
        /*
         * Grouped by the sentence, not listed per option.
         *
         * On day zero all four are shut for the same reason, and the ungrouped
         * version printed the server's whole "not enough scored decisions yet"
         * sentence four times in a column 300px wide. The reason is the
         * server's; how many times it is worth reading is ours.
         */
        <div className="px-4 py-3 flex flex-col gap-2" style={{ borderTop: edge(8) }}>
          {byReason.map(([why, names]) => (
            <div key={why} className="text-[10px] leading-relaxed" style={{ color: "var(--text3)" }}>
              <span style={{ color: "var(--text3)" }}>{names.join(", ")}</span>
              {" — "}
              {why}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
