import type { Contributes, Field, NoteActionContribution, NoteReply, NoteStatus, PanelContribution, PrNote, PrNotesSummary, PrRun, UiAction, UiNode, UiOpenPr } from "../../../shared/pluginUi.ts"

export type { Contributes, Field, NoteActionContribution, NoteReply, NoteStatus, PrNote, PrNotesSummary, PrRun, UiAction, UiNode, UiOpenPr };

/** A panel as the window gets it: what was declared, who declared it, and
 *  what the plugin last drew there (null until it draws, or once it stops). */
export type PluginPanel = PanelContribution & {
  plugin: string;
  publisher: string;
  running: boolean;
  /** The plugin's own mark (see PluginMark): whether it ships an icon, its
   *  colour, and a stamp that changes when it is reinstalled. */
  hasIcon?: boolean;
  color?: string | null;
  stamp?: string;
  tree: UiNode | null;
  updatedAt: number | null;
};

export type PluginPrNotes = {
  ok: boolean;
  runs: (PrRun & { plugin: string })[];
  notes: (PrNote & { plugin: string })[];
  publishers: Record<string, string>;
  /** The finding buttons each RUNNING plugin declared. Absent from an older app. */
  noteActions?: Record<string, NoteActionContribution[]>;
};
