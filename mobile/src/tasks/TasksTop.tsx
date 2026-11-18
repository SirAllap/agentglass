/*
 * The Tasks tab's own header: the computer, a magnifier, the filter, the bell
 * and the menu — the shape the phone mock draws, for both sources this tab
 * reads.
 *
 * ── why the screen draws it instead of the navigator ──────────────────────
 * The tab used to wear the navigator's header (name, usage, bell, gear) while
 * every source under it drew a second row of its own: a source pill, a board
 * picker, a "Mine first" chip. Two rows of chrome above a board is a third of
 * the screen spent before the first card. The mock gives the destination ONE
 * header and puts what used to be rows behind it — search behind the
 * magnifier, the filter behind the funnel, the source and the board behind the
 * menu — so the board starts where the mock starts it.
 *
 * ── the menu is a panel, not a sheet ──────────────────────────────────────
 * Three or four words, each with a line saying what it does. A sheet for that
 * is a screenful of empty surface and a gesture to dismiss; the panel closes
 * on the same tap that opened it, and on a tap outside.
 */
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ComputerChip } from "../nav/ComputerChip.tsx";
import { InboxBell } from "../nav/InboxBell.tsx";
import { Glyph, type GlyphName } from "../nav/glyphs.tsx";
import { C, RADIUS, SPACE, T, tint } from "../theme.ts";
import { TAP } from "../ui.tsx";

/** One line of the panel. `note` is the small word on the right — the board's
 *  name, the source's name — because a menu of nouns alone cannot say which
 *  of two boards is the one on screen. */
export interface TopMenuItem {
  key: string;
  label: string;
  icon: GlyphName;
  note?: string;
  /** A hairline above this line: the menu's own grouping, as the mock's is. */
  gap?: boolean;
  onPress: () => void;
}

const BOX = 44;

/** The mock's pill at the head of the tab: a dot, what the tab is reading, and
 *  the chevron that changes it. It names the repository for the issues source
 *  and the board for Jira — the thing the sheet under it switches. */
function WherePill({ label, onPress }: { label: string; onPress: () => void }): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Reading: ${label}. Change it`}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        height: 44, maxWidth: 230, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        paddingHorizontal: 4, borderRadius: 10, backgroundColor: pressed ? C.bg3 : "transparent",
      })}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.warning }} />
      <Text numberOfLines={1} style={{ color: C.text, fontSize: 16, fontWeight: "600", letterSpacing: -0.2, flexShrink: 1 }}>
        {label}
      </Text>
      <Glyph name="down" color={C.text3} size={16} />
    </Pressable>
  );
}

function IconButton({ label, onPress, on, children }: {
  label: string;
  onPress: () => void;
  on?: boolean;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={on === undefined ? undefined : { selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: BOX, height: BOX, alignItems: "center", justifyContent: "center",
        borderRadius: RADIUS.md, backgroundColor: pressed ? C.bg3 : "transparent",
      })}
    >
      {children}
    </Pressable>
  );
}

export function TasksTop({ search, onSearch, searching, onOpenSearch, onCloseSearch, onFilter, filterOn, items, note, where }: {
  /** What is typed. The row is drawn only while `searching`. */
  search: string;
  /** Absent when this source searches with a row of its own. */
  onSearch?: (text: string) => void;
  searching?: boolean;
  onOpenSearch?: () => void;
  onCloseSearch?: () => void;
  /** Absent when this source has nothing to filter. */
  onFilter?: () => void;
  filterOn?: boolean;
  items: TopMenuItem[];
  note?: string;
  /** What the tab is reading, in the mock's pill: a dot, the name, a chevron,
   *  and a sheet that changes it. Absent only while there is nothing to name. */
  where?: { label: string; onPress: () => void };
}): React.ReactNode {
  const insets = useSafeAreaInsets();
  const [menu, setMenu] = useState(false);

  return (
    <View style={{ zIndex: 20, paddingTop: insets.top, backgroundColor: C.bg }}>
      <View style={{
        height: 52, flexDirection: "row", alignItems: "center", gap: SPACE.xs, paddingHorizontal: SPACE.xs,
      }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          {where ? <WherePill label={where.label} onPress={where.onPress} /> : <ComputerChip compact />}
        </View>
        {onSearch ? (
          <IconButton
            label="Search the cards"
            on={searching}
            onPress={() => {
              setMenu(false);
              if (searching) { onSearch(""); onCloseSearch?.(); } else { onOpenSearch?.(); }
            }}
          >
            <Glyph name="search" color={searching ? C.primary : C.text2} size={22} />
          </IconButton>
        ) : null}
        {onFilter ? (
          <IconButton label={filterOn ? "Filters, on" : "Filters"} on={filterOn} onPress={() => { setMenu(false); onFilter(); }}>
            <Glyph name="filter" color={filterOn ? C.primary : C.text2} size={22} />
            {filterOn ? (
              <View style={{ position: "absolute", top: 4, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: C.primary }} />
            ) : null}
          </IconButton>
        ) : null}
        <InboxBell />
        <IconButton label="More: where the cards come from, and settings" onPress={() => setMenu((was) => !was)}>
          <Glyph name="more" color={C.text2} size={22} />
        </IconButton>
      </View>

      {searching && onSearch ? (
        <View style={{ paddingHorizontal: SPACE.sm, paddingBottom: SPACE.sm }}>
          <SearchField
            value={search}
            onChange={onSearch}
            onClose={() => { onSearch(""); onCloseSearch?.(); }}
            placeholder="Search · ORBIT-1042 · mine · High"
            label="Search the cards"
          />
        </View>
      ) : null}

      {menu ? (
        <>
          <View
            accessibilityRole="menu"
            style={{
              position: "absolute", top: insets.top + 52, right: SPACE.sm, minWidth: 250,
              backgroundColor: C.bg2, borderWidth: 1, borderColor: C.border, borderRadius: RADIUS.lg,
              paddingVertical: SPACE.xs, paddingHorizontal: SPACE.sm,
              shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 24, shadowOffset: { width: 0, height: -8 },
              elevation: 12,
            }}
          >
            {items.map((item) => (
              <View key={item.key}>
                {item.gap ? <View style={{ height: 1, backgroundColor: C.border, marginVertical: SPACE.xs }} /> : null}
                <Pressable
                  accessibilityRole="menuitem"
                  accessibilityLabel={item.label}
                  onPress={() => { setMenu(false); item.onPress(); }}
                  style={({ pressed }) => ({
                    minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
                    paddingHorizontal: SPACE.sm, borderRadius: RADIUS.md,
                    backgroundColor: pressed ? C.bg3 : "transparent",
                  })}
                >
                  <Glyph name={item.icon} color={C.text2} size={18} />
                  <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, flex: 1 }}>{item.label}</Text>
                  {item.note ? (
                    <Text numberOfLines={1} style={{ color: C.text3, fontSize: T.small, maxWidth: 110 }}>{item.note}</Text>
                  ) : null}
                </Pressable>
              </View>
            ))}
            {note ? (
              <Text style={{
                color: C.text3, fontSize: T.eyebrow, lineHeight: 15, paddingHorizontal: SPACE.sm,
                paddingTop: SPACE.sm, paddingBottom: SPACE.xs,
                borderTopWidth: 1, borderTopColor: C.border, marginTop: SPACE.xs,
              }}>{note}</Text>
            ) : null}
          </View>
        </>
      ) : null}
      <View style={{ height: 1, backgroundColor: C.border }} />
    </View>
  );
}

/** The one search field on this tab, behind the magnifier: a capsule, the
 *  mark, the words and the way out. Exported because the issues list draws
 *  the same field under the same header. */
export function SearchField({ value, onChange, onClose, placeholder, label }: {
  value: string;
  onChange: (text: string) => void;
  onClose: () => void;
  placeholder: string;
  label: string;
}): React.ReactNode {
  return (
    <View style={{
      height: BOX, flexDirection: "row", alignItems: "center", gap: SPACE.sm, paddingLeft: SPACE.md,
      borderRadius: RADIUS.pill, borderWidth: 1, borderColor: value ? C.primary : C.border, backgroundColor: C.bg2,
    }}>
      <Glyph name="search" color={C.text3} size={18} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.text4}
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="search"
        autoFocus
        style={{ flex: 1, height: BOX, color: C.text, fontSize: T.body, padding: 0 }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close search"
        onPress={onClose}
        style={{ width: BOX, height: BOX, alignItems: "center", justifyContent: "center" }}
      >
        <Glyph name="close" color={C.text3} size={18} />
      </Pressable>
    </View>
  );
}

/** The pill that names the source this tab is reading, and opens the choice.
 *  The mock draws it under the header for the sources that have no board. */
export function SourcePill({ title, note, icon, onPress }: {
  title: string;
  note?: string;
  icon: GlyphName;
  onPress: () => void;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Task source: ${title}. Change the source`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: TAP, flexDirection: "row", alignItems: "center", gap: SPACE.sm,
        marginHorizontal: SPACE.sm, marginTop: SPACE.sm, paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.border,
        backgroundColor: pressed ? C.bg3 : C.bg2,
      })}
    >
      <Glyph name={icon} color={C.text2} size={17} />
      <Text numberOfLines={1} style={{ color: C.text, fontSize: T.body, fontWeight: "600", flexShrink: 1 }}>
        {title}
      </Text>
      {note ? <Text style={{ color: C.text3, fontSize: T.small, marginLeft: "auto" }}>{note}</Text> : null}
      <Glyph name="down" color={C.text3} size={16} />
    </Pressable>
  );
}

/** A chip in the strip over the board: an answer in force (with its ×), or the
 *  one that offers more (`add`). 44 high, the mock's own row. */
export function FilterChip({ label, face, on, add, onPress }: {
  label: string;
  /** A face before the label: the mock's "you" mark on Mine first. */
  face?: React.ReactNode;
  on?: boolean;
  add?: boolean;
  onPress: () => void;
}): React.ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={add ? undefined : { selected: !!on }}
      accessibilityLabel={add ? label : `Remove filter ${label}`}
      onPress={onPress}
      style={({ pressed }) => ({
        height: TAP, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: SPACE.md,
        borderRadius: RADIUS.md, borderWidth: 1,
        borderStyle: add || !on ? "dashed" : "solid",
        borderColor: add || !on ? C.border2 : C.border,
        backgroundColor: add || !on ? "transparent" : pressed ? C.bg3 : C.bg2,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {face}
      {add ? <Glyph name="plus" color={C.text3} size={15} /> : null}
      <Text numberOfLines={1} style={{ color: add || !on ? C.text3 : C.text2, fontSize: T.small, fontWeight: "600" }}>
        {label}
      </Text>
      {!add && on ? <Glyph name="close" color={C.text4} size={14} /> : null}
    </Pressable>
  );
}

/** The "you" mark on Mine first: two letters on the accent, as the board's
 *  own avatars are drawn. */
export function YouFace(): React.ReactNode {
  return (
    <View style={{
      width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center",
      backgroundColor: tint(C.primary, 0.18),
    }}>
      <Text style={{ color: C.primary, fontSize: 10, fontWeight: "700" }}>YO</Text>
    </View>
  );
}
