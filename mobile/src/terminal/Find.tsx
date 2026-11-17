/*
 * Search the pane's scrollback (s66).
 *
 * The query is answered on the phone rather than in the page, because the page
 * can only hand up text and the search is the part worth testing — see
 * find.ts. What this draws is a field, a count that follows every keystroke, and
 * one row per matching line with its line number, so a hit can be jumped to.
 *
 * The ceiling is written down in the sheet rather than hidden: this searches
 * what the phone holds. Older lines live on the computer, and the pane asks for
 * them only when somebody scrolls to the top.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { countLine, find } from "./find.ts";
import { Btn, Note, Sheet, TAP } from "../ui.tsx";
import { Glyph } from "../nav/glyphs.tsx";
import { C, MONO, RADIUS, SPACE, T, tint } from "../theme.ts";

/**
 * How many hit rows are drawn.
 *
 * A query like `e` matches every line in the buffer, and two thousand rows in a
 * ScrollView is a sheet that takes a second to open on the one screen where
 * somebody is waiting for an answer. The count still says the truth; the list
 * says what it is showing.
 */
const HIT_CAP = 50;

export function FindSheet({ open, onClose, lines, looking, onLooking, onMarks, onJump, title }: {
  open: boolean;
  onClose: () => void;
  /** The pane's buffer, oldest first; null while the page is being asked. */
  lines: string[] | null;
  /** True between opening the sheet and the page answering. */
  looking: boolean;
  /** Ask the page for its buffer again. */
  onLooking: () => void;
  /** Paint these lines, standing on `at` (a line, or -1 for none). */
  onMarks: (lines: number[], at: number) => void;
  /** Scroll the pane to a line. */
  onJump: (line: number) => void;
  /** What this search is about: the window and its project. */
  title: string;
}): React.ReactNode {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => find(lines ?? [], query), [lines, query]);
  /** Which hit the sheet stands on. A new query stands on the first one; the
   *  index is clamped rather than reset because a longer query can shrink the
   *  list under somebody who was already stepping through it. */
  const [at, setAt] = useState(0);
  useEffect(() => { setAt(0); }, [query]);
  const standing = hits.length ? Math.min(at, hits.length - 1) : -1;
  const current = standing >= 0 ? hits[standing]!.line : -1;
  /** The line the sheet last jumped to, so closing can keep THAT one marked
   *  instead of wiping the highlight the person just navigated by. */
  const landed = useRef<number | null>(null);

  /*
   * Every matching line is marked, and the first is the one the pane stands on —
   * the mock's own reading of a search: you can see where the hits are before
   * you choose one. An empty query marks nothing, which is how the pane goes
   * back to being just a pane.
   */
  useEffect(() => {
    if (!open) return;
    onMarks(hits.map((h) => h.line), current);
  }, [open, hits, current, onMarks]);

  /*
   * A closed sheet must not leave its marks on the pane — except the one it was
   * just sent to, which is what the person is now reading. A query typed for the
   * last search is not somebody's next one.
   */
  useEffect(() => {
    if (open) return;
    setQuery("");
    const at = landed.current;
    landed.current = null;
    onMarks(at === null ? [] : [at], at === null ? -1 : at);
  }, [open, onMarks]);

  /** Jump, and get out of the way: the highlight is on the pane the sheet
   *  covers, so a jump that left the sheet up would show nothing. */
  const jump = (line: number): void => {
    landed.current = line;
    onJump(line);
    onClose();
  };

  /* The screen's blank rows are not lines somebody can search, and counting
     them told a 14-line pane it had "41 lines". The drawing's own count is the
     printed ones. */
  const shown = lines?.reduce((n, l) => (l.trim() ? n + 1 : n), 0) ?? 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Search the scrollback"
      subtitle={`${title} · every line this window printed. Tapping a match moves the pane to it.`}
      tall
      footer={<Btn label="Done" tone="primary" onPress={onClose} />}
    >
      <View style={{
        flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        minHeight: 52, paddingLeft: SPACE.md, paddingRight: SPACE.xs,
        borderRadius: RADIUS.pill, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg,
      }}>
        <Glyph name="search" color={C.text3} size={18} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="rail, error, bun test…"
          placeholderTextColor={C.text4}
          accessibilityLabel="Search the scrollback"
          autoCorrect={false}
          autoCapitalize="none"
          autoFocus
          returnKeyType="search"
          onSubmitEditing={() => { if (current >= 0) jump(current); }}
          style={{ flex: 1, color: C.text, fontSize: T.body, paddingVertical: SPACE.sm }}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: SPACE.sm }}>
        <Text style={{ color: C.text3, fontSize: T.eyebrow }}>
          {lines === null
            ? (looking ? "Reading what this pane holds…" : "The pane has not answered.")
            : `${countLine(shown, hits.length)}${standing >= 0 ? ` · ${standing + 1} of ${hits.length}` : ""}`}
        </Text>
        <Text style={{ color: C.text4, fontSize: T.eyebrow }}>oldest first</Text>
      </View>

      <ScrollView style={{ maxHeight: 320, marginTop: SPACE.sm }} keyboardShouldPersistTaps="handled">
        {hits.slice(0, HIT_CAP).map((hit) => (
          <Pressable
            key={hit.line}
            onPress={() => jump(hit.line)}
            accessibilityRole="button"
            accessibilityState={{ selected: hit.line === current }}
            accessibilityLabel={`Line ${hit.line + 1}: ${hit.text.trim()}`}
            style={({ pressed }) => ({
              flexDirection: "row", alignItems: "flex-start", gap: SPACE.sm,
              minHeight: TAP, paddingVertical: SPACE.sm,
              borderTopWidth: 1, borderTopColor: C.border,
              backgroundColor: pressed ? C.bg3 : hit.line === current ? tint(C.primary, 0.12) : "transparent",
            })}
          >
            <Text style={{ color: C.text4, fontSize: T.eyebrow, width: 32, paddingTop: 2 }}>
              L{hit.line + 1}
            </Text>
            <Text numberOfLines={2} style={{ flex: 1, color: C.text, fontSize: T.small, fontFamily: MONO }}>
              {marked(hit.text.trim(), query) || " "}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {hits.length > HIT_CAP ? (
        <Text style={{ color: C.text3, fontSize: T.eyebrow, marginTop: SPACE.sm }}>
          Showing the first {HIT_CAP} of {hits.length}. Type more of the line to narrow it.
        </Text>
      ) : null}

      {lines !== null && hits.length === 0 && query.trim() ? (
        <Note>Nothing in this pane matches. It holds the last two thousand lines; older ones are on the computer.</Note>
      ) : null}
      {lines === null ? (
        <View style={{ flexDirection: "row", marginTop: SPACE.sm }}>
          <Btn label="Read the pane again" onPress={onLooking} style={{ flex: 1 }} />
        </View>
      ) : null}
      <Note>
        Search reads what this phone holds. Older lines live on the computer; the pane asks for them
        only when you scroll to the top.
      </Note>
    </Sheet>
  );
}

/** The query, marked where it lands in a hit — the mock's `<mark>`. One
 *  substring, because `find` matched one substring; a second match on the same
 *  line is not marked, which is the same list `find` would give for it. */
function marked(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <Text style={{ backgroundColor: tint(C.primary, 0.22) }}>{text.slice(at, at + needle.length)}</Text>
      {text.slice(at + needle.length)}
    </>
  );
}
