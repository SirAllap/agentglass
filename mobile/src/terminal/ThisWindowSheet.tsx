/*
 * The "This window" sheet: the switches for the attached pane, and the places
 * that pane's checkout leads to. It was drawn inline in the 3,500-line terminal
 * screen; the screen keeps every piece of state and passes in the values and
 * the requests, so this file only draws and decides nothing.
 */
import { Pressable, Text, View } from "react-native";
import { Btn, Note, Sheet, SheetRow, Switch } from "../ui.tsx";
import { RADIUS, SPACE, T } from "../theme.ts";
import type { Tab } from "./tabs.ts";
import { groupOf } from "./windows.ts";

/** The pane colours this sheet reads; the screen's `paneColours` has them. */
export interface SheetColours { primary: string; bg3: string; bg4: string; text2: string; error: string }

export interface ThisWindowSheetProps {
  more: boolean;
  onClose: () => void;
  open: Tab | undefined | null;
  computer: string;
  K: SheetColours;
  fit: boolean;
  columns: number;
  raw: boolean;
  rail: boolean;
  dirty: boolean;
  /** Already worded by `textLabel(columns, paneWidth)`. */
  textSub: string;
  stepText: (dir: 1 | -1) => void;
  onToggleFit: () => void;
  onToggleRaw: () => void;
  onToggleRail: () => void;
  openFind: () => void;
  startSelect: () => void;
  onManage: () => void;
  onFiles: () => void;
  onRepos: () => void;
  onAgents: () => void;
  onGoToWork: () => void;
}

export function ThisWindowSheet({
  more, onClose, open, computer, K, fit, columns, raw, rail, dirty, textSub, stepText,
  onToggleFit, onToggleRaw, onToggleRail, openFind, startSelect, onManage, onFiles, onRepos, onAgents, onGoToWork,
}: ThisWindowSheetProps) {
  return (
    <Sheet
      open={more}
      onClose={onClose}
      title="This window"
      subtitle={open ? `${open.name} · ${groupOf(open)} · ${computer}` : "Nothing attached"}
      footer={open ? (
        <Btn
          label="Go to the work behind this pane"
          onPress={onGoToWork}
          style={{ flex: 1 }}
        />
      ) : undefined}
    >
      {open ? (
        <View style={{ paddingBottom: SPACE.md }}>
          {/*
            The two switches that used to live on the key bar. Both are about
            THIS pane rather than the app: `fit` reaches out and resizes a
            window on somebody's computer, and `raw` changes what the next
            thing you type does.
          */}
          <SheetRow
            glyph="fit"
            leadColor={K.primary}
            label="Fit the window to this phone"
            sub={fit
              ? "On. The window is this phone's size, here and on the computer's own screen."
              : "Off. The window on the computer stays at its own width."}
            trail={<Switch on={fit} />}
            onPress={onToggleFit}
          />
          <Note>
            <Text style={{ fontWeight: "700" }}>Turning this on changes the window on the computer too</Text>
            {` — the person at the desk sees the pane narrow to ${columns} columns.`}
          </Note>
          <SheetRow
            glyph="type"
            label="Send every key straight through"
            sub={raw
              ? "On. Typing in the field sends each key as you press it."
              : "Off. You compose a whole line and Return sends it."}
            trail={<Switch on={raw} />}
            onPress={onToggleRaw}
          />
          {/*
            Text size, in points, and the columns it comes out as. One stored
            number and two units: the column count is what goes down the
            socket, so a size is turned into the columns that fit at it.
          */}
          <SheetRow
            glyph="type"
            label="Text size"
            sub={textSub}
            onPress={() => stepText(1)}
            trail={(
              <View style={{ flexDirection: "row", gap: SPACE.xs }}>
                {([-1, 1] as const).map((dir) => (
                  <Pressable
                    key={dir}
                    onPress={() => stepText(dir)}
                    accessibilityRole="button"
                    accessibilityLabel={dir < 0 ? "Smaller text" : "Larger text"}
                    style={({ pressed }) => ({
                      width: 40, height: 40, alignItems: "center", justifyContent: "center",
                      borderRadius: RADIUS.sm, backgroundColor: pressed ? K.bg4 : K.bg3,
                    })}
                  >
                    <Text style={{ color: K.text2, fontSize: T.title }}>{dir < 0 ? "−" : "+"}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          />
          {/* s03's switch: the rail without turning the phone. Null means the
              phone decides, which is why turning it back off is possible. */}
          <SheetRow
            glyph="fit"
            label="Landscape"
            sub={rail
              ? "On. The keys keep a rail of their own, and the pane takes the height."
              : "Off. Turn the phone and the pane takes the height; the keys keep a rail of their own."}
            trail={<Switch on={rail} />}
            onPress={onToggleRail}
          />
          {/* The two extras the mock draws over this pane (s66, s03). Neither
              needs a route: the page already holds the text and the lines. */}
          <SheetRow
            glyph="search"
            label="Search the scrollback"
            sub="This pane, every line it has printed."
            onPress={openFind}
          />
          <SheetRow
            glyph="list"
            label="Select and copy"
            sub="Pick lines, then copy them as plain text."
            onPress={startSelect}
          />
          <SheetRow
            glyph="type"
            label="Rename this window"
            sub={`Now called ${open.windowName}.`}
            onPress={onManage}
          />
          <SheetRow
            glyph="close"
            danger
            leadColor={K.error}
            label="Close this window"
            sub={open.agent
              ? "An agent is still working in it. This cannot be undone."
              : "The window goes away on the computer. This cannot be undone."}
            onPress={onManage}
          />
          <SheetRow
            glyph="folder"
            label="Files in this checkout"
            sub={`${groupOf(open)} · browse and read`}
            onPress={onFiles}
          />
          <SheetRow
            glyph="branch"
            label="Source control for this checkout"
            sub={dirty ? "Uncommitted changes · Changes, Log, Branches" : "Changes, Log, Branches"}
            onPress={onRepos}
          />
          <SheetRow
            glyph="bot"
            label={`Agents on ${computer}`}
            sub="1 working, 2 finished · read-only here"
            onPress={onAgents}
          />
        </View>
      ) : (
        <Note>Attach to a pane first — these all need to know which checkout.</Note>
      )}
    </Sheet>  );
}
