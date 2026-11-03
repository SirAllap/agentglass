// The four routes under "Add…" in the Open projects modal, as data: what each
// says, in what order, and which pane it opens. The menu draws them and gives
// each its icon; keeping the list here lets a test read it instead of the JSX.
export type AddRowKey = "folder" | "github" | "clone" | "new";

export const ADD_ROWS: readonly { key: AddRowKey; title: string; sub: string; hue: "success" | "info" | "primary" | "warning" }[] = [
  { key: "folder", title: "Folder…", sub: "Every git repo inside it shows up here.", hue: "success" },
  { key: "github", title: "GitHub repo", sub: "Review its PRs. Nothing is cloned.", hue: "info" },
  { key: "clone", title: "Clone from URL", sub: "Clone a remote git repository onto this machine.", hue: "primary" },
  { key: "new", title: "New project", sub: "An empty folder with a git repository in it.", hue: "warning" },
];

/** What the folder route does: the system chooser where there is one, the
 *  typed-path pane where there is not (a browser tab). It is offered either way,
 *  so a first run in a tab has the main route too. */
export const folderRoute = (canBrowse: boolean): "chooser" | "typed" => (canBrowse ? "chooser" : "typed");
