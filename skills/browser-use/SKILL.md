---
name: browser-use
description: Drive agentglass's built-in browser — the one already signed in to the sites this project uses. Use when a task needs a page behind a login (a dashboard, a ticket, a staging app), when a URL fetched with curl comes back signed out or JavaScript-rendered, or when the user asks you to look at, click through, or screenshot something in a browser. It is a full browser for agents: DevTools, fake network responses, isolated profiles, a virtual clock.
---

# Using the built-in browser

`curl` gets you the signed-out version of everything that matters, because the
session lives in a browser. agentglass has one, already signed in to whatever
the person using it is signed in to. `agentglass-browser` drives it, and it is
built for you rather than lent to you: the whole DevTools protocol is here, so
is running JavaScript, so is faking a broken API.

## Start here, in this order

```bash
agentglass-browser health                     # is anything listening; always answers
agentglass-browser open https://example.com/app
agentglass-browser observe --shot             # EVERYTHING at once
```

`observe` is the verb to reach for first. One answer with the url and title,
whether the view is **visible and focused**, the console and the network since
last time, a tree of the interactive page addressed by role and accessible
name, the current value of every input, and optionally the picture. Polling six
verbs in turn is where the time goes.

## Then the whole interaction in ONE call

```bash
agentglass-browser do "click #save" "waitfor #done" --observe
```

Starting this process costs ~69 ms before it says a word, so six separate verbs
spend most of a second on startup alone. `do` spends it once. Measured: **618 ms
→ 94 ms** for six verbs. Steps stop at the first failure, which comes back with
its own console errors and failed requests.

## Wait for something instead of polling for it

```bash
agentglass-browser events --wait 30           # answers the MOMENT something happens
```

The cost of polling is not the clock, it is the twenty answers sitting in your
context for the rest of the session. `events` waits on the server and answers
once. "Nothing happened in thirty seconds" is an answer, not a failure.

## The verbs, by what you reach for them for

```
look        observe · read · text · html · region · shot · frames · console · network
page        resize · zoom (the one Ctrl+/Ctrl- move) · emulate · throttle
act         click · type · select · check · fill · hover · dblclick · rightclick
            focus · blur · press · scroll · drag · upload
wait        wait · waitfor (--until network-idle | no-timers) · events
navigate    open · back · forward · reload
tabs        tabs · tab · newtab · closetab · profiles
containers  whoami · profiles (--make/--drop) · newtab --profile · lanes
identity    cookies · storage · permission · permissions · clipboard
run code    eval · eval --file · addInitScript · expose · exposed
inspect     cdp · debug · listeners · coverage · trace
network     fake · intercept · throttle · headers · har
pretend     emulate · resize · clock · settings
evidence    shot · record · pdf · save · download · audit --script
batch       do (and `lanes` for several pages at once)
```

## The things worth knowing before you start

**Stable ids beat invented selectors.** Every node in an `observe` comes with an
id like `e17`, stamped on the element so it survives a re-render. Every verb
that takes a selector takes one of those instead. Do not go inventing CSS.

**A failure explains itself.** It comes back with the console errors and failed
requests from just before it, and a screenshot. `selector matched 3 elements`
names them with position and text. You do not need a second call to find out
what went wrong.

**JavaScript is yours.** `eval` reads the app's own runtime — a store, a
component's state, `document.visibilityState`. `eval --file` for anything a
shell would mangle. `addInitScript` runs BEFORE the page's own scripts, on every
navigation, which is the one thing `eval` cannot do.

**DevTools, whole.** `cdp <Domain.method>` relays the entire protocol —
breakpoints, heap snapshots, the accessibility tree. On top of it: `debug` (a
DOM breakpoint answers "who deleted this row", and `debug where` gives you the
stack AND the locals in one call), `listeners`, `coverage` ("is my change even
being loaded").

**Break the network on purpose.** `fake` forces a 404, a 500 or a hang on a URL
pattern; `intercept` pauses a request at the network level, which catches what
the page did not ask for through fetch; `throttle` makes the machine slow, and
offline is a *different* failure from slow. That is how you reproduce "the board
freezes when the API is down" against the real app instead of in a unit test.

## You already have an identity — you do not have to remember to ask

Several agents drive this browser at once, so every one of them works in a
container of its own: its own cookies, its own storage, its own tabs. The CLI
derives a name from your session, mints the container on first use, and sends
every later verb to the tab it opened for you.

```bash
agentglass-browser open https://example.com/app    # your own container, your own tab
agentglass-browser read                            # goes to the tab that open made
```

**Open a tab before you act.** Isolation is the tab your identity is holding,
so a verb from an identity that has none has nowhere of its own to go. It is
refused, by name, rather than sent to whichever tab is in front — that fall-back
is how an agent that had declared its identity on every single call still drove
another agent's page seven times, with `ok: true` each time and no signal on
either side. Your identity loses its tab when the tab is closed, when an `open`
failed, and when the app restarts, so the refusal is a thing you will meet
normally: answer it with `open`.

```bash
agentglass-browser --shared read                   # the active tab, on purpose
agentglass-browser --page t7-abc123 read           # a tab you name yourself
```

**`whoami` is how you check before you act**, in one call that touches no page:

```bash
agentglass-browser whoami
{"you": {"identity": "orbit-a1b2", "tab": "t7-abc123", "tabLive": true},
 "activeTab": {"id": "t9-ef01", "profile": "peer-3c3c", "url": "...", "title": "..."}}
```

`tabLive: false` is exactly the state the refusal above names: you hold no tab,
so open one. `activeTab.profile` is the container that owns the screen right
now — if it is not yours, another agent is working there and a `--shared` verb
would land in the middle of it. `profiles` answers the same question about
everybody, with a tab count and a last-activity per container.

Name it yourself when the name matters — a person looking at the window should
be able to tell whose it is:

```bash
agentglass-browser open --as review-pr-540 https://example.com/app
agentglass-browser profiles --drop review-pr-540   # and everything in it
```

Two things about that name, both of which have cost somebody an hour:

* **A container is machine-wide and picking an existing name JOINS it.** Making
  one and joining somebody else's are the same gesture, so the CLI tells you
  which just happened — a stderr notice naming the container and how many
  tabs it already holds; `profiles` adds who created it and when it was last
  used. `profiles --drop` on a container you did not
  create is refused; `--force` is there for when you really mean it. **That
  check compares the name you gave, and anyone can give any name** — every one
  of these processes is you, on your machine, so `--as somebody-else` is
  somebody else as far as the guard can tell. It is there to catch two agents
  colliding on `review-pr-540`, not to keep anyone out.
* **The name is cut at 24 characters**, and the CLI says so when it bites. Two
  names that differ only past character 24 are one identity, one cookie jar and
  one tab.

**Your derived identity is per SESSION, not per process.** Subagents inherit
their parent's session id, so every subagent of one session derives the same
name, the same container and the same remembered tab — and because `open`
navigates a remembered tab rather than minting a new one, siblings running at
once repaint one shared page. **If you fan out, give each child its own `--as`
name.**

`--as` and `--profile` are the same flag, and both work on every verb, before
or after it. `--page <tab>` addresses somebody else's tab on purpose;
`--shared` is the one way into the DEFAULT container, which is the person's own
session and every other agent's. You will almost never want it.

**Drop yours when the work is done.** A container left behind is a login nobody
meant to keep.

**Never work in a container somebody else made.** Several agents use this
browser at once. Two sharing a container share a login, and the second one to
act changes what the first is looking at — silently, because nothing about a
cookie says who set it. The ones already there belong to the person or to
another agent.

**Name it after yourself and the task.** `review-pr-540`, not `test`. A person
looking at the window has to be able to tell whose it is, and so does the next
agent deciding what is safe to touch.

**Drop it when the work is done.** A container left behind is a login nobody
meant to keep. If you need more than one, make more than one — with names that
say which is which.

Each container has a colour, and the tabs in it carry the same colour, so the
row at the bottom and the tab strip agree at a glance.

**Two actors at once.** `lanes` drives several pages CONCURRENTLY — running
them in turn would let the watching page see the change already made, which is
the thing being tested.

**Time is yours too.** `clock` advances the page's clock without waiting, seals
`Date.now` and `Math.random`, and freezes animations. A thirty-second timer is
an instant, not a thirty-second wait.

**Watch what you spend.** Every verb takes `--max-tokens`, `--out FILE
--summary`, and `--since-last` on the observations. 82.7% of what an agent
spends is tool output, and what comes in is re-read every turn afterwards.
`region` gives you one subtree instead of the page — a modal is fifteen nodes
inside three hundred.

**Evidence goes to disk.** `shot --out file.png` writes the PNG and prints the
path; without `--out` it prints base64 to stdout, which is what you want when
you are handing the image straight back rather than keeping it. `--selector` for
one element, `--highlight --label` to draw a box and a caption on it, `record`
for N frames to a GIF, `pdf` for the print stylesheet, `save` for MHTML that
still renders offline. `audit --script` turns the session into a bash script
somebody else can re-run.

```bash
agentglass-browser shot --out ~/proof/01-before.png
agentglass-browser shot --highlight "#total" --label "still 18 of 75" --out ~/proof/02-after.png
agentglass-browser record ~/proof/frames --frames 8 --every 400 --gif ~/proof/flow.gif
```

**A shot frames the whole PAGE, not the pane it is sitting in.** You do not have
to resize anything first, and you should not: the frame comes from the
document's own scroll size, so nothing is cut off no matter how wide the browser
panel happens to be. The PNG is one pixel per CSS pixel, so the same page gives
the same image on any machine — the display's DPI and the desktop's scale factor
do not leak into your evidence, and a before/after pair taken on different days
is comparable. There is no `scale` option: it tiled the page into copies of
itself, the same way `--full-page` did.

This is worth knowing because it used to be false. The frame came from the
pane's width, so a dashboard needing 2014 css captured in a 1416-wide pane came
back with its right-hand column sliced off, and the same page minutes later came
back a different size. If you are reading an older transcript that tells you to
call `resize` before capturing, that advice is obsolete.

**There is no full-page shot.** It repeated any sticky header once per screen,
so it was removed rather than left to produce pictures that duplicate content.
The default frame already covers the document; use `--clip` or `--selector` when
you want less than that.

**`--page <tab id>` captures another tab** without switching to it, and the same
flag works on `read`, `click`, `type`, `wait` and `observe`. Tab ids come from
`tabs`.

**It is one browser, and it is theirs.** The person can see every page you open.
Open what the task needs and leave it somewhere reasonable.

## Guardrails, and why they are there

`AGENTGLASS_BROWSER_ORIGINS` limits where the browser may be pointed.
`AGENTGLASS_BROWSER_READONLY=1` allows observing and refuses acting — a verb
that is not explicitly an observation counts as acting. Every call is in an
audit log you can export with `audit`, so "I only touched the local one" is
checkable rather than a promise.

**Secrets are redacted automatically** — in the log and in what verbs return.
A password typed into a field is removed because the PAGE is asked whether the
field is a password, not because its name looked like one. That matters: this
exists because another browser tool autofilled a real password and it stayed in
a transcript.

## Exit codes and failure

Every command exits non-zero and prints one line to stderr when it did not do
the thing. Branch on that rather than on the text. A capture that produced no
pixels writes NO file and exits 1 — an empty PNG with a confident exit code is
worse than an error, because it contaminates evidence without saying so.

## The same thing as an MCP server

```
claude mcp add agentglass-browser -- agentglass-browser-mcp
```

Every verb above, as a tool with a schema. Same relay, same rules, same
guardrails. Use whichever fits.

## When it cannot reach the browser

The browser is a pane in the agentglass window, and it does not have to be the
view on screen: every verb works, screenshots included, while the person reads a
diff. Do not go looking for a way to bring it to the front — the app is theirs.

If no pane is mounted, the CLI opens one and retries. If the WINDOW is shut,
`health` says so and nothing can be done about it from here: say so and ask. Do
not fall back to fetching the signed-out page and reporting on what you found
there, which is the failure this whole tool exists to avoid.
