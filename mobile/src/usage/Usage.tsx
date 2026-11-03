/*
 * How much of the plan is used: a chip on every header, and the sheet it opens.
 *
 * ── why a chip, and why everywhere ───────────────────────────────────────
 * It was a card at the bottom of Settings. The question it answers — can I
 * start a long one — is asked right before starting one, from wherever you
 * are, and Settings is where nobody is at that moment. A number three taps
 * away was a number nobody looked at.
 *
 * The chip is one value: what is used of the window closest to running out,
 * across every provider. That is what actually stops a long turn — the
 * tightest window, not the average of them — and a ring around it says the
 * same thing to somebody who does not read the digits. The sheet has the rest:
 * every window, when each one resets, and which reading it came from.
 *
 * ── what it never does ───────────────────────────────────────────────────
 * Draw a number it does not have. Until an answer lands, and on a computer
 * whose agents report no quota, there is no chip at all. A phone that could
 * not reach the computer keeps the last reading (see use-usage.ts) and the
 * sheet dates it; an empty ring there would read as a spent plan, which is the
 * one error that would change what somebody does.
 */
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import type { QuotaWindow } from "../../../shared/types.ts";
import {
  accountHeading, ageLabel, estimatedWindows, planReadAt, planState, planWindows, providerCount, quotaTone, readLine,
  resetLabel, sourceLine, tightestWindow, usedOf, windowName,
} from "../model/quota.ts";
import { useUsage } from "../state/use-usage.ts";
import { C, RADIUS, SPACE, T, type Palette } from "../theme.ts";
import { Btn, Note, Sheet, TAP } from "../ui.tsx";

/** The tone of a level, from `quotaTone` over what was used: 60% used is amber
 *  and 85% is red, the same two lines the dashboard draws. */
function toneOf(K: Palette, usedPercent: number): string {
  const tone = quotaTone(usedPercent);
  return tone === "crit" ? K.error : tone === "bad" ? K.warning : K.success;
}

function Ring({ used, color, track, size = 16, stroke = 2.4 }: {
  used: number;
  color: string;
  track: string;
  size?: number;
  stroke?: number;
}): React.ReactNode {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const half = size / 2;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={half} cy={half} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      {used > 0 ? (
        <Circle
          cx={half} cy={half} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${(c * used) / 100} ${c}`}
          transform={`rotate(-90 ${half} ${half})`}
        />
      ) : null}
    </Svg>
  );
}

/** A clock that moves once a minute, which is the grain of every label here. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The chip. `colors` is the palette of the header it sits in — the terminal's
 * header is the desk's, not the phone's.
 */
export function UsageChip({ colors = C }: { colors?: Palette }): React.ReactNode {
  const K = colors;
  const { rows } = useUsage();
  const [open, setOpen] = useState(false);
  const top = tightestWindow(rows);
  if (!top) return null;
  const used = usedOf(top.window);
  const tone = toneOf(K, top.window.usedPercent);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Usage: ${used}% of the ${windowName(top.window.label)} window used. Opens usage.`}
        onPress={() => setOpen(true)}
        hitSlop={{ top: 6, bottom: 6 }}
        style={({ pressed }) => ({
          flexDirection: "row", alignItems: "center", gap: 6,
          height: 32, paddingLeft: 9, paddingRight: 11, borderRadius: 16,
          backgroundColor: pressed ? K.bg4 : K.bg3, borderWidth: 1, borderColor: K.border,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        <Ring used={used} color={tone} track={K.border2} />
        <Text style={{ color: K.text, fontSize: T.small, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {used}%
        </Text>
        <Text style={{ color: K.text3, fontSize: T.small }}>{top.window.label}</Text>
      </Pressable>
      <UsageSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** One window, as a bar of what is USED of it, the same direction the desk's
 *  bars and numbers take: the two surfaces are two windows onto one plan, and a
 *  monitor that says 82% while the hand says 39.8% left is a bug in one of them.
 *  A window with nothing used draws no bar. `estimate` tags this one bar, since
 *  a row can mix the console's numbers with one this PC filled in. */
function Meter({ label, window: w, now, estimate }: {
  label: string;
  window: QuotaWindow;
  now: number;
  estimate: boolean;
}): React.ReactNode {
  const used = usedOf(w);
  const tone = toneOf(C, w.usedPercent);
  const resets = resetLabel(w.resetsAt, now);
  const tag = estimate ? "estimate · this PC" : "";
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${used}% used${resets ? `, resets ${resets}` : ""}${tag ? `, ${tag}` : ""}`}
      style={{ gap: SPACE.sm, paddingVertical: SPACE.md }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline" }}>
        <Text style={{ color: C.text, fontSize: T.body, fontWeight: "500", flex: 1 }} numberOfLines={1}>{label}</Text>
        <Text style={{ color: tone, fontSize: T.body, fontWeight: "600" }}>{used}% used</Text>
      </View>
      <View style={{ height: 8, borderRadius: 4, backgroundColor: C.bg4, overflow: "hidden" }}>
        {used > 0 ? <View style={{ width: `${used}%`, height: "100%", borderRadius: 4, backgroundColor: tone }} /> : null}
      </View>
      {resets ? <Text style={{ color: C.text3, fontSize: T.small }}>Resets {resets}</Text> : null}
      {tag ? <Text style={{ color: C.text3, fontSize: T.small }}>{tag}</Text> : null}
    </View>
  );
}

/**
 * Every window, the tightest stated once at full size.
 *
 * Four states, and none of them collapsed. The expensive one is "could not
 * reach the computer", which must never be drawn as an empty bar: a phone off
 * the network would otherwise report the plan as spent. `planState` in
 * model/quota.ts is what keeps the four apart.
 */
export function UsageSheet({ open, onClose }: { open: boolean; onClose: () => void }): React.ReactNode {
  const { rows, loaded, error, reload } = useUsage();
  const now = useMinute();
  const state = planState(loaded, rows);
  const top = tightestWindow(rows, now);
  /* Only worth naming the provider on each bar when more than one is
     reporting. On a machine with Claude alone, "Claude 5h" on every row is one
     word of signal and one of furniture. Two logins of one provider are still
     one provider: the heading over each login's bars tells them apart. */
  const available = (rows ?? []).filter((r) => r.available);
  const several = providerCount(available) > 1;
  const age = top ? ageLabel(top.observedAt, now) : "";

  return (
    <Sheet open={open} onClose={onClose} title="Usage">
      <View style={{ gap: SPACE.sm, paddingBottom: SPACE.md }}>
        {state === "loading" ? <Note>Asking the computer…</Note> : null}
        {state === "unreachable" ? (
          <Note tone="bad">{error ?? "The computer did not answer about the plan."}</Note>
        ) : null}
        {state === "empty" ? <Note>No agent on this computer reports a plan quota.</Note> : null}

        {top ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.md, paddingVertical: SPACE.xs }}>
            <Text style={{
              color: toneOf(C, top.window.usedPercent), fontSize: 44, fontWeight: "600", lineHeight: 50,
            }}>{usedOf(top.window)}%</Text>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: C.text, fontSize: T.body, fontWeight: "500" }}>
                used in the {windowName(top.window.label).toLowerCase()} window
              </Text>
              <Text style={{ color: C.text3, fontSize: T.small }}>
                {[
                  several ? top.provider : "",
                  top.window.resetsAt ? `resets ${resetLabel(top.window.resetsAt, now)}` : "",
                  // The headline's own window can be this PC's arithmetic while
                  // the others are the plan's: the desk tags it beside the figure.
                  top.estimated ? "estimate · this PC" : "",
                  // The age belongs beside the number it qualifies: a good
                  // reading served for a day looks exactly like a live one.
                  age,
                ].filter(Boolean).join(" · ")}
              </Text>
            </View>
          </View>
        ) : null}

        {available.length ? (
          <View style={{
            backgroundColor: C.bg3, borderRadius: RADIUS.lg, paddingHorizontal: SPACE.lg,
          }}>
            {available.map((row, n) => {
              const heading = accountHeading(row);
              const plan = planWindows(row, now);
              const estimated = estimatedWindows(plan);
              // The source and the age of the reading actually drawn: an
              // estimate and a console count look identical in a bar.
              const read = row.provider === "opencode"
                ? [sourceLine(row, plan), readLine(planReadAt(row, plan), now)].filter(Boolean).join(" · ")
                : "";
              return (
                <View
                  key={`${row.provider}:${row.account?.label ?? ""}`}
                  style={n > 0 ? { borderTopWidth: 1, borderTopColor: C.border } : undefined}
                >
                  {/* Read-only on purpose: switching a login is the desk's.
                      "active" is a word, so it reads without the colour. */}
                  {heading ? (
                    <View style={{ flexDirection: "row", alignItems: "baseline", paddingTop: SPACE.md }}>
                      <Text style={{ color: C.text2, fontSize: T.small, fontWeight: "600", flex: 1 }} numberOfLines={1}>{heading}</Text>
                      {row.account?.active ? <Text style={{ color: C.text3, fontSize: T.small }}>active</Text> : null}
                    </View>
                  ) : null}
                  {plan.windows.map((w, i) => (
                    <View key={w.label} style={i > 0 ? { borderTopWidth: 1, borderTopColor: C.border } : undefined}>
                      <Meter
                        label={several ? `${row.label} · ${windowName(w.label)}` : windowName(w.label)}
                        window={w}
                        now={now}
                        estimate={estimated.has(w.minutes)}
                      />
                    </View>
                  ))}
                  {read ? (
                    <Text style={{ color: C.text3, fontSize: T.small, paddingBottom: SPACE.md }}>{read}</Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        {top ? (
          <Text style={{ color: C.text3, fontSize: T.small, paddingTop: SPACE.xs }}>
            The chip on every header is the tightest window. It turns amber at 60% used and red at 85%.
          </Text>
        ) : null}

        {/* Only on the failure. The poll comes back by itself every five minutes
            and again on the way into the app, so a button here is for the one
            case where waiting five minutes to find out whether the wifi came
            back is the wrong offer. */}
        {state === "unreachable" ? <Btn label="Ask again" onPress={reload} style={{ minHeight: TAP }} /> : null}
      </View>
    </Sheet>
  );
}
