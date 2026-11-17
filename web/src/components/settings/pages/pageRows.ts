// Rows of the Files, Diffs, Browser and Git & PRs pages as data (section, id, label, help).
// Each page renders from this and the tests read the same table.

export interface PageRowDef { id: string; section: string; label: string; help: string }

export const FILES_ROWS: PageRowDef[] = [
  { id: "finder.hidden", section: "browsing", label: "Show hidden files", help: "Lists entries whose name starts with a dot." },
  { id: "finder.foldersFirst", section: "browsing", label: "Folders first", help: "Lists folders above files." },
  { id: "finder.sizes", section: "browsing", label: "Show file sizes", help: "Shows the size or item count on the selected row." },
  { id: "finder.preview", section: "browsing", label: "Single-click file previews", help: "Shows a quick preview when you select a supported file." },
  { id: "finder.autoplay", section: "browsing", label: "Autoplay media previews", help: "Starts video, audio and GIF previews as soon as they open." },
  { id: "finder.renderDocs", section: "browsing", label: "Render documents by default", help: "Opens Markdown and HTML as a page, not as source." },
  { id: "finder.sort", section: "look", label: "Default sort", help: "Sets the order a folder opens in." },
  { id: "finder.textSize", section: "look", label: "Text size", help: "Sets the size of the text in the Finder." },
  { id: "finder.thumb", section: "look", label: "Thumbnail size", help: "Sets how big image thumbnails are." },
  { id: "finder.actions", section: "actions", label: "Custom actions and open-with defaults", help: "Set these from the gear in the Finder's machine panel." },
  { id: "finder.peek", section: "more", label: "Folder peeking", help: "Previews a folder when you hover it in Icons and List." },
  { id: "finder.mirror", section: "more", label: "Mirror columns selection", help: "Shows the chosen folder in the next column as you move." },
  { id: "finder.f1", section: "more", label: "Show F1 Shortcuts button", help: "Shows the footer button; the key works either way." },
  { id: "finder.reset", section: "danger", label: "Reset finder settings", help: "Puts every setting on this page back to its default." },
];

export const DIFF_ROWS: PageRowDef[] = [
  { id: "diff.split", section: "open", label: "Default view", help: "Chooses the view a diff opens in." },
  { id: "diff.syntaxTheme", section: "open", label: "Diff syntax theme", help: "Sets the colours of code inside a diff." },
  { id: "diff.groupBy", section: "open", label: "Group by", help: "Chooses how changed files are grouped." },
  { id: "diff.showIgnored", section: "open", label: "Show ignored", help: "Lists files that git ignores." },
  { id: "diff.showOutside", section: "open", label: "Show outside the worktree", help: "Lists changes in folders outside the project." },
  { id: "diff.wrap", section: "open", label: "Wrap long lines", help: "Off scrolls sideways instead of wrapping." },
];

export const BROWSER_ROWS: PageRowDef[] = [
  { id: "browser.home", section: "opens", label: "Home page", help: "Sets where the browser opens; empty means a blank page." },
  { id: "browser.searchEngine", section: "opens", label: "Search engine", help: "Searches your words when you type them in the address bar." },
  { id: "browser.agentsWithoutScreen", section: "agents", label: "Let agents browse with the pane closed", help: "Their tabs load in the background; the pane does not open or take focus." },
  { id: "browser.importFrom", section: "logins", label: "Import from", help: "The vault reads this browser once; no agent reads it after." },
  { id: "browser.putIn", section: "logins", label: "Put in", help: "Your own browser, the vault, or both." },
  { id: "browser.importHistory", section: "logins", label: "Bring history", help: "Lets the address bar finish what you type." },
  { id: "browser.importBookmarks", section: "logins", label: "Bring bookmarks", help: "Ranks your bookmarks first in the address bar." },
  { id: "browser.sites", section: "logins", label: "Sites in browser", help: "Choose which sites come across, or forget them again." },
  { id: "browser.vaultSignOut", section: "logins", label: "Sign agents out when their task ends", help: "On by default; off keeps the login in the agent's lane until removed." },
  { id: "browser.vaultSignInOnVisit", section: "logins", label: "Sign agents in on first visit", help: "New agent containers sign in from the vault on first visit, except sensitive sites." },
  { id: "browser.vaultDefault", section: "logins", label: "Default vault for a site in several", help: "Used when a site is in several vaults and the agent names none." },
  { id: "browser.vaultSites", section: "sites", label: "Sites in the vault", help: "Login expiry, last agent, sensitive mark and pull log for each site." },
  { id: "browser.vaultEmpty", section: "sites", label: "Remove all", help: "Empties the vault and signs agent lanes out; your own browser stays signed in." },
  { id: "browser.whyCookies", section: "logins", label: "Why cookies, and what comes across", help: "A password manager cannot run in this browser." },
  { id: "browser.removeUnused", section: "containers", label: "Remove unused", help: "Agent containers idle over a day with no tab, and their cookies; never yours." },
  { id: "browser.agentsHelp", section: "agents", label: "How agents use this browser", help: "The three lines to paste, why a window beats curl, and who may drive." },
  { id: "browser.agentLines", section: "agents", label: "Three lines to paste into an agent", help: "Tells an agent to use this browser, so it keeps your logins." },
  { id: "browser.whyWindow", section: "agents", label: "Why a window and not curl", help: "Opens pages that need your logins, which a shell fetch cannot." },
];

export const GIT_ROWS: PageRowDef[] = [
  { id: "cleanup.autoCleanDays", section: "merge", label: "Also clean up merged PRs older than", help: "Cleans old merged pull requests on its own, with the same safety checks." },
  { id: "cleanup.include", section: "merge", label: "Leftovers a cleanup plan holds", help: "Picks which kinds of leftovers a cleanup plan lists for you." },
  { id: "cleanup.config.briefsDir", section: "merge", label: "Briefs folder", help: "Moves finished briefs into an archive folder here, never deletes them." },
  { id: "cleanup.config.teardownScript", section: "merge", label: "Teardown script", help: "Runs this script on a worktree before a cleanup removes it." },
  { id: "cleanup.config.dockerImage", section: "merge", label: "Docker image tag template", help: "Tells a cleanup which image tag your build gives a checkout." },
  { id: "cleanup.config.dockerVolumes", section: "merge", label: "Orphan volume patterns", help: "Lists volumes a cleanup may offer once their checkout is gone." },
  { id: "cleanup.config.dockerKeep", section: "merge", label: "Volumes a cleanup never lists", help: "Keeps these volume names out of every cleanup list." },
  { id: "review.gate", section: "ready", label: "Review findings block merge-ready pull requests", help: "Keeps a pull request with open serious findings out of the ready lane." },
  { id: "notifications.ciOnlyApproved", section: "watching", label: "Checks fail", help: "Tells you about failed checks only once a pull request is approved." },
  { id: "notifications.talk", section: "watching", label: "Conversation", help: "Chooses which comments and reviews interrupt you." },
];
