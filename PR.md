## What does this PR do?

Puts what is left of the plan on the phone's Home tab.

The desk has had a Usage panel for a while; the phone had nothing, so the one
question you ask away from the machine — *have I got enough left to start this*
— could only be answered by going back to the machine. This adds a **Plan left**
card under the connection line: a headline for the window closest to running
out, then one bar per window.

Two decisions worth naming, because they are what makes it a phone card rather
than a smaller copy of the desk's:

* **Every number is REMAINING, not used.** The desk asks "how much have I spent"
  and has room for five bars and somebody sitting in front of them. A phone is
  looked at for two seconds on the way somewhere.
* **The headline is the window that runs out first**, across every provider —
  not the first row in the list. A 4% -remaining weekly window behind a
  comfortable 5-hour one is exactly the thing you needed to know.

No server change. `GET /usage/providers` already answers a phone at `read`
scope, and every number in it is the server's — this branch decides what to
show, not what is true.

The decisions live in `mobile/src/model/quota.ts` as plain data functions rather
than inside the screen, for the reason `dates.ts` gives: a helper inside a React
Native screen is a helper no test can reach, because the test runner cannot
parse `react-native`'s entry point. That is what makes the 128 lines of
`quota.test.ts` possible.

A third commit fixes something QA found that is **not this branch's bug**: with
the machine unreachable, the phone rendered
`fetch failed: java.net.ConnectException: Failed to connect to /127.0.0.1:4000`
verbatim — in the card and again in the status line above it. `describeFailure`
knew only React Native's own `Network request failed`; Hermes on Android hands
the JVM exception through instead. Checked on `d722871` rather than assumed:
`describe()` there matches that one string and returns `e.message` for
everything else, so **this repairs the shipped app, not just this branch** — the
Plan card is merely the first screen that showed it to somebody.

The address half of that matters more than the wording. A phone pairs over the
LAN or a tailnet, so the address in a connection error is the user's own
network, and a screenshot of a disconnected Home screen published where their
machine lives. Nothing that reaches a caller carries one now, including messages
this code has never seen.

A fourth, unrelated commit fixes the QA harness: it spawned the literal
`/usr/bin/google-chrome`, which Arch does not install (it ships
`google-chrome-stable`), and with `stderr: "ignore"` the failure surfaced twenty
seconds later as "chrome never opened a page" — a message about the browser that
says nothing about the binary being missing. It now tries the known paths and
`$CHROME`, and says which it looked at when it finds none.

## How was it tested?

**Measured:**

* `npm run typecheck` in `mobile/` — clean, both configs.
* `bun test` in `mobile/` — **387 pass / 0 fail** across 34 files, including
  `mobile/test/quota.test.ts` (the tightest-window pick, the clamp on a provider
  reporting over 100%, the tone thresholds, the reset and age labels, and the
  four states of the card), and `mobile/test/api-errors.test.ts` (the six
  unreachable shapes Android produces, the timeout keeping its own sentence,
  every address spelling scrubbed, and two filenames surviving the scrub).
* `bun scripts/qa.ts` — 9/9 screens against a scratch server, with Home drawing
  real data (39% left of Claude, 5h, resetting in 3h 27m).
* Rebased onto `d722871` and re-run, so the numbers above are against current
  main rather than against the tree this was written on.

**Not measured, and worth saying plainly:** this has never run on a real device
or an emulator. The APK has never been built from this branch, and the `qa.ts`
sweep drives the web target through the shims in `metro.config.js` — so it is
evidence about the model and the layout, and not about Hermes. The manual pass
is written up in `QA.md` on this branch, including the three behaviours a tester
would otherwise read as bugs (no card during the first poll, a number that does
not move between runs, and bars labelled by window only when one provider
reports).
