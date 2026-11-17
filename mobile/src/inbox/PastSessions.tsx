/*
 * Past sessions, as the terminal's sheet draws them: grouped, paged and
 * searchable, instead of the eight that used to fit.
 *
 * All of it reads the rows already fetched for this checkout (`/agent/sessions`,
 * one call per open), and every control here narrows that answer instead of
 * asking again — which is why a search can be typed at and the list moves under
 * the thumb rather than after a round trip. The rules themselves are
 * `model/pastSessions.ts`; this is the drawing.
 *
 * A row that is running now is not resumed, it is gone to: the sheet says where
 * and the caller decides what the tap does with it.
 */
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { AgentSessionRow } from "../../../shared/types.ts";
import {
  CHIPS, PAGE, countLine, filterSessions, groupsOf, page, sessionLine, type PastChip,
} from "../model/pastSessions.ts";
import { Field, FilterChips, Label, Note, SheetRow } from "../ui.tsx";
import { C, SPACE, T } from "../theme.ts";

export function PastSessions({ rows, root, onOpen }: {
  /** `null` is "the read has not answered yet", which is not the same as an
   *  empty list — one is a wait, the other is a fact. */
  rows: AgentSessionRow[] | null;
  root: string;
  onOpen: (row: AgentSessionRow) => void;
}): React.ReactNode {
  const [chip, setChip] = useState<PastChip>("checkout");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const filtered = useMemo(
    () => filterSessions(rows ?? [], { chip, query, root }),
    [rows, chip, query, root],
  );
  const p = useMemo(() => page(filtered, shown), [filtered, shown]);
  const groups = useMemo(() => groupsOf(p.rows), [p.rows]);

  const narrow = (next: PastChip): void => { setChip(next); setShown(PAGE); };

  return (
    <View style={{ gap: SPACE.sm }}>
      <Label text="Past sessions" />
      <Field
        value={query}
        onChangeText={(v) => { setQuery(v); setShown(PAGE); }}
        placeholder="Search titles and last lines"
        kind="text"
      />
      <FilterChips
        label="What the search reads"
        options={[...CHIPS]}
        value={chip}
        onChange={narrow}
      />

      {rows === null ? (
        <Note>Asking the computer…</Note>
      ) : filtered.length === 0 ? (
        <Note>
          {query
            ? `No session in ${chip === "week" ? "the last 7 days" : "this scope"} matches “${query}”.`
            : chip === "checkout"
              ? "No agent has run in this checkout yet."
              : "No session in this scope."}
        </Note>
      ) : (
        groups.map((g) => (
          <View key={g.id} style={{ gap: 2 }}>
            <Text style={{ color: C.text3, fontSize: T.eyebrow, fontWeight: "700", letterSpacing: 0.6, paddingTop: SPACE.xs }}>
              {g.label.toUpperCase()}
            </Text>
            {g.rows.map((session) => (
              <SheetRow
                key={session.id}
                /* The agent's own title, which is the first thing it was asked.
                   Cut at a length rather than a word: these run to paragraphs
                   and a row is one line. */
                label={session.title.trim().slice(0, 80) || session.id.slice(0, 8)}
                sub={sessionLine(session)}
                onPress={() => onOpen(session)}
              />
            ))}
          </View>
        ))
      )}

      {p.more > 0 ? (
        <SheetRow
          label="Show older sessions"
          sub={`${p.more} more · ${countLine(p)}`}
          onPress={() => setShown((n) => n + PAGE)}
        />
      ) : p.total > PAGE ? (
        <Note>{countLine(p)}</Note>
      ) : null}
    </View>
  );
}
