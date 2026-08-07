---
name: browser-use
description: Drive agentglass's built-in browser — the one already signed in to the sites this project uses. Use when a task needs a page behind a login (a dashboard, a ticket, a staging app), when a URL fetched with curl comes back signed out or JavaScript-rendered, or when the user asks you to look at, click through, or screenshot something in a browser.
---

# Using the built-in browser

`curl` gets you the signed-out version of everything that matters, because the
session lives in a browser. agentglass has one, in a pane, already signed in to
whatever the person using it is signed in to. `agentglass-browser` drives it.

```bash
agentglass-browser open https://github.com/notifications
agentglass-browser read                       # title, url, and the visible text
agentglass-browser click "a.notification-list-item-link"
agentglass-browser type "#search" "billing bug" --submit
agentglass-browser wait ".results"            # until it appears, or it fails
agentglass-browser shot /tmp/page.png         # png on disk; read it if you can see images
agentglass-browser text ".invoice-total"      # one element, instead of the whole page
agentglass-browser back                       # and `forward`
agentglass-browser scroll --to bottom         # or --by -400, or --selector "#footer"
agentglass-browser press Escape               # Enter, Tab, Escape, arrows, PageUp/Down, Home, End
```

Every command exits non-zero and prints one line to stderr when it did not do
the thing — a selector that matched nothing, a page that never loaded, a window
that is not open. Branch on that rather than on the text.

## How to work with it

**Read before you click.** `read` gives you the page as text. Decide from that
what to click, rather than guessing a selector from the URL.

**Then read narrowly.** Once you know where the answer is, `text ".selector"`
costs a fraction of `read` on a long page. Reach for `read` to orient yourself,
`text` to get the value.

**Selectors are CSS, and stable ones win.** `#login`, `a[href="/settings"]`,
`button[type=submit]`. A selector built from a generated class name works once.

**Waiting is a verb.** After anything that navigates or loads, `wait` for
something that only exists on the page you expect. It is how you find out you
landed on a login page instead.

**Scrolling changes what `read` returns**, because it reports the *visible*
text. If a page looks truncated, scroll and read again — `scroll` tells you
where it ended up and whether it is at the bottom.

**It is one browser, and it is theirs.** The person can see every page you open,
and there are no tabs — `open` replaces what is on screen. Do not go rummaging
in it: open what the task needs, and leave it somewhere reasonable.

**Nothing here runs arbitrary JavaScript**, by design. If a task cannot be done
with these six verbs, say so rather than looking for a way around them.

## When it cannot reach the browser

The browser is a pane in the agentglass window. If that pane is not showing, the
CLI opens it for you and retries once — you will see the app switch to it, which
is expected.

What it cannot fix is the window being shut: `the agentglass window is not open`
means exactly that. Say so and ask. Do not fall back to fetching the signed-out
page and reporting on what you found there, which is the failure this whole tool
exists to avoid.
