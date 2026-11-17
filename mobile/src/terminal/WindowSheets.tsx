/*
 * The two sheets that act on a window rather than on the pane: the one that
 * renames or closes it, and the one that opens a new one. They were drawn
 * inline at the bottom of the 3,700-line terminal screen; the screen keeps the
 * state and the requests, and passes what each sheet needs.
 */
import { Pressable, Text, View } from "react-native";
import { Btn, Field, HoldButton, Note, Sheet, SheetRow, TAP } from "../ui.tsx";
import { C, SPACE, T } from "../theme.ts";
import { closeWords } from "./windowActions.ts";
import type { Tab } from "./tabs.ts";

/** One row of `/terminal/agents`. Declared here rather than in shared/ for the
 *  same reason PrViewCounts is: it is this route's answer shape and nothing
 *  else reads it — see the note in app/(tabs)/prs.tsx. */
export interface AgentOffer {
  id: string;
  title: string;
  what: string;
  /** On THIS machine. A name with no binary behind it is drawn and refused,
   *  never offered. */
  installed: boolean;
  /** Whether this CLI has a skip-permissions flag at all. */
  canBypass: boolean;
}

export function ManageWindowSheet({
  managing, onClose, newName, setNewName, manageWhy, setManageWhy, nameProblem, busy, windowDo,
}: {
  managing: Tab | null;
  onClose: () => void;
  newName: string;
  setNewName: (v: string) => void;
  manageWhy: string | null;
  setManageWhy: (v: string | null) => void;
  nameProblem: string | null;
  busy: boolean;
  windowDo: (tab: Tab, op: "rename" | "kill-window", title?: string) => Promise<void>;
}) {
  return (
    <Sheet open={!!managing} onClose={onClose} title={managing?.label ?? "Window"}>
      {managing ? (
        <View style={{ gap: SPACE.md, paddingBottom: SPACE.md }}>
          <Field
            label="Name"
            value={newName}
            onChangeText={(t) => { setNewName(t); setManageWhy(null); }}
            onSubmitEditing={() => { if (!nameProblem) void windowDo(managing, "rename", newName); }}
          />
          {/* Said only once something was typed: an empty field is not yet
              a mistake. */}
          {manageWhy ?? nameProblem ? <Note tone="bad">{manageWhy ?? nameProblem}</Note> : null}
          <Btn
            label="Rename"
            tone="primary"
            busy={busy}
            disabled={newName === managing.windowName || !!nameProblem}
            onPress={() => { void windowDo(managing, "rename", newName); }}
          />
          <Note>{closeWords(managing)}</Note>
          <HoldButton
            action="window.kill"
            label="Hold to close"
            spoken={managing.windowName}
            disabled={busy}
            onConfirm={() => { void windowDo(managing, "kill-window"); }}
            onRelease={(said) => setManageWhy(said)}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

export function NewWindowSheet({
  open, onClose, title, subtitle, agents, agentsFailed, askingAgents, askAgents, openAgent,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  agents: AgentOffer[] | null;
  agentsFailed: boolean;
  askingAgents: boolean;
  askAgents: () => Promise<void>;
  openAgent: (kind: string, yolo: boolean) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} subtitle={subtitle}>
      {/* The answer to `/terminal/agents` can fail, and a list that waits for
          it for ever is worse than one that says so: the Shell row needs no
          agent list, so it is here either way, with a way to ask again. */}
      <View style={{ gap: SPACE.xs, paddingBottom: SPACE.md }}>
        {agents === null ? (
          agentsFailed ? (
            <View style={{ gap: SPACE.sm, paddingBottom: SPACE.sm }}>
              <Note tone="bad">The computer did not say which agents it has. A shell still works.</Note>
              <Btn label="Try again" busy={askingAgents} onPress={() => { void askAgents(); }} />
            </View>
          ) : (
            <Note>Asking the computer which agents it has…</Note>
          )
        ) : null}
        {(agents ?? []).map((a) => (
          <View key={a.id} style={{ gap: SPACE.xs, paddingVertical: SPACE.xs }}>
            <SheetRow
              label={a.installed ? a.title : `${a.title} — not installed`}
              sub={a.installed ? a.what : `Install it on the computer to open it here. ${a.what}`}
              disabled={!a.installed}
              onPress={() => openAgent(a.id, false)}
            />
            {/* Only where the CLI HAS the flag, and only when it is there
                to run. A switch that buys nothing is a switch that teaches
                the wrong thing about what pressing it did. */}
            {a.installed && a.canBypass ? (
              <Pressable
                onPress={() => openAgent(a.id, true)}
                accessibilityRole="button"
                style={({ pressed }) => ({
                  minHeight: TAP, justifyContent: "center",
                  paddingHorizontal: SPACE.lg, opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text style={{ color: C.warning, fontSize: T.small }}>
                  …and skip permission prompts
                </Text>
                <Text style={{ color: C.text3, fontSize: T.eyebrow }}>
                  It will not stop to ask before running a command.
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {/* Always here, agents installed or not: a prompt in the project
            is a thing people want on its own, and the server treats
            "shell" as a window with no agent in it. */}
        <SheetRow
          label="Shell"
          sub="A plain prompt in this project, no agent."
          onPress={() => openAgent("shell", false)}
        />
        {agents && agents.every((a) => !a.installed) ? (
          <Note tone="bad">
            No agent CLI is installed on that computer. Every choice here opens a plain shell.
          </Note>
        ) : agents ? (
          <Note>Only agents installed on the computer can be tapped; the rest are greyed with the reason.</Note>
        ) : null}
      </View>
    </Sheet>
  );
}
