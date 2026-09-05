# What agentglass can do to your tmux

The differentiator and the danger are the same sentence. agentglass does not
start its own multiplexer and draw a picture of it — it attaches to the tmux
server **you** started, so every window it can list is a window it can also
resize, rename, move, kill and rebind. That is the reason a pane you opened by
hand an hour ago shows up in the tab strip at all, and it is the reason this
page exists.

Nothing here is a hypothetical. Twice, a bug in this file did the thing this
page is about: a session somebody was working in got squeezed to 80×24 by an
attach that carried the wrong size, and `resize-window -A` wrote
`window-size manual` across five windows at once — a setting that does not undo
itself when the client disconnects. Both are fixed. Both are why the inventory
below is written down rather than left to be discovered.

## The switch

```bash
AGENTGLASS_TMUX_OBSERVE_ONLY=1     # `true`, `yes` and `on` are accepted too
```

Set it and every command that could change **your** tmux becomes a no-op that
records what it would have run. Reads keep working, so the tab strip, the pane
list, the worktree readout and the capture that feeds the terminal view all
still draw — you get the whole cockpit and it cannot touch anything of yours.

"Yours" is load-bearing, and it is the distinction the rest of this page turns
on. There are two tmux servers in play:

- **Yours** — whatever socket your own sessions live on. `server/src/tmuxctl.ts`
  is the only module that reaches it, because it is the only one that takes a
  socket to talk to and walks the ones it finds. Everything in the inventory
  below is in that file, and the switch guards all of it.
- **Ours** — a private server the pane engine runs on the socket named
  `agentglass` (`server/src/tmuxbin.ts:90`, overridable with
  `AGENTGLASS_TMUX_SOCKET`). `server/src/tmuxpane.ts` drives it and never
  passes a socket at all: every command it issues is hard-wired to `-L
  agentglass`. That is where a chat pane lives, and it is why the app can give
  you panes on a machine where you run no tmux of your own.

`tmuxpane.ts` is deliberately **not** behind the switch. It creates and kills
sessions and sends keys into panes — all of it on our own server, none of it
reachable from your sessions. Guarding it would only stop the app working while
protecting nothing.

It is read per call rather than latched at startup, so it can be turned on for
one process without restarting anything else, and `suppressedTmuxWrites()`
returns what was refused, oldest first, which is what the regression test
asserts against.

**One knock-on to expect.** With the switch on, the phone-mirror remount cannot
do its job, so it reports failure; after three consecutive failures the terminal
layer stops retrying and goes quiet about that session. Nothing is damaged and
nothing of yours is touched — but if you are running observe-only and a phone
mirror stops reconnecting, that is why, and it is the intended trade.

**The default is off.** Turning it on by default would make the tab strip
read-only for everybody to protect the minority who never wanted writes at all,
and that is a product decision, not a safety fix. What this page owes you is the
list and the switch.

## Every write, and what triggers it

Seventeen exported functions in `server/src/tmuxctl.ts` issue commands that
change tmux state on a socket that may be yours. Grouped by what they can reach.

### Can reach a session you started yourself

| Function | tmux commands | When it runs |
| --- | --- | --- |
| `runAction` (`:824`) | `new-window`, `kill-window`, `rename-window`, `move-window`, `select-window`, `resize-window`, `set-option` | You click a control in the tab strip — new tab, close, rename, reorder, switch. One user action, one command. |
| `focusPane` (`:2062`) | `select-pane`, `select-window`, `switch-client` | You click a pane anywhere in the app, or follow a "needs you" chip to the agent that raised it. |
| `selectPane` (`:2099`) | `select-pane` | Focus moves within a window you are already looking at. |
| `fitWindow` (`:3192`) | `resize-window`, `set-option` | A window is sized to the viewport showing it — on attach, and when the pane you are watching changes shape. Session-qualified, never a bare window id: a bare `-t @0` answers "no such window" once a grouped session shares it, and fails silently. |
| `reclaimPinnedWindow` (`:3293`) | `resize-window`, `refresh-client`, `set-option` | A window a phone had pinned is handed back. It only undoes a size **it** took: the window carries `@agx-had-size` recording that we took it and what it was before. A window you sized yourself with `resize-window -x 80` has no such mark and is left alone. |
| `restoreWindows` (`:3409`) | `resize-window`, `refresh-client`, `set-option` | A phone attach ends and the windows it changed are put back — including unzooming, because a window a phone zoomed still reports `window_zoomed_flag` 1 after that client is gone. |
| `sweepPinnedWindows` (`:3613`) | `resize-window`, `refresh-client`, `set-option` | Startup, and periodically. It walks only the sockets that carry our marks — not `tmuxSockets()`, which answers "every tmux server this user could be running". 2.4 ms when nothing is marked, which is every boot after a clean shutdown. |
| `setStatusLine` (`:1383`) | `set-option` | Theme sync writes the status line, if you have that on. |
| `clearAsk` (`:1327`) | `set-option` | Takes the "this agent wants you" note off a window once the panel has been told. |
| `scrollPhonePane` (`:2141`) | `copy-mode`, `send-keys` | A phone scrolls a pane. |
| `leaveCopyMode` (`:2188`) | `send-keys … cancel` | Copy mode is exited. `cancel`, not `send-keys q` — `q` is your binding to change, and undoing our own action must not depend on your config. |
| `pinnedSockets` (`:2504`) | `set-option` | Narrows which servers the sweep is allowed to walk. |
| `newWindowRunning` (`:1150`) | `new-window` | You start a chat or an agent that wants a pane. |
| `attachArgvFor` (`:2905`) | `new-session`, `attach-session`, `resize-window`, `resize-pane`, `select-pane`, `select-window`, `set-option` | Builds the command line for an attach. |

### Can only reach sessions agentglass created

| Function | tmux commands | When it runs |
| --- | --- | --- |
| `remountPhoneClient` (`:2711`) | `new-session`, `kill-session`, `resize-pane`, `switch-client`, `set-option` | A phone's mirror session is rebuilt. The caller only remounts an attach that already had a mirror, so the target is a phone session by construction. |
| `endPhoneSession` (`:3357`) | `kill-session` | A phone disconnects. Matched by exact name, never by prefix — a prefix match here would be a session we did not name. |
| `deskAttachArgv` (`:2807`) | `new-session`, `attach-session` | The desk terminal opens its own session. |

## What it never does

- It does not kill a session it did not create. `kill-session` appears twice
  above and both are phone mirrors matched by exact name.
- It does not write your `~/.tmux.conf`, and it does not install a plugin.
- It does not run a shell command in a session of yours. There is no `run-shell`
  anywhere in the server, and the only `send-keys` aimed at your socket carry a
  copy-mode movement (`scroll-up`, `scroll-down`, `cancel`) — never text, never
  a command line. The `send-keys` that do carry keystrokes go through
  `tmuxpane.ts`'s wrapper — from that file, from `understudy-pane.ts` (the
  clone's own pane) and from `agentops.ts` (the named agents a script seats,
  where a script may press one of a short list of named keys) — and that
  wrapper is hard-wired to our own socket.
- It does not touch a tmux server it has no mark in, during the periodic sweep.

## Checking it yourself

The claim on this page is about the state of a session **after** the calls have
been made, so the test that backs it uses a real tmux server rather than a mock —
a mock could only confirm the module called it politely, which is not the claim:

```bash
cd server && bun test test/tmux-observe-only.test.ts
```

Every case runs the same sequence twice: once with the switch off, where the
session must come out visibly changed, and once with it on, where it must come
out byte-identical. The control is the important half — a "nothing changed" test
passes trivially by doing nothing at all.

The test drives its own server on its own socket with `-f /dev/null`. That flag
is not decoration: a tmux started without it reads the config of whoever is
running the suite, and a config with tmux-continuum in it restores that person's
entire workspace into the test's server. That has happened here.
