# QA — feat/phone-plan-usage

Branch `feat/phone-plan-usage`, HEAD `cd872f2`, rebased onto `d722871` (main,
which includes #487). **Local only, not on origin, no PR.**

Adds a **Plan left** card to the phone's Home tab: a headline showing the window
closest to running out — as REMAINING, not used — plus one bar per window.
No server change: `GET /usage/providers` already answers a phone at `read` scope.

## Run it

The APK has never been built from this branch. From this worktree:

```bash
export ANDROID_HOME=$HOME/Android/Sdk JAVA_HOME=/usr/lib/jvm/java-17-openjdk
cd mobile && npm ci
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleRelease          # ~6 min
adb -s emulator-5554 install -r app/build/outputs/apk/release/app-release.apk
```

Pair against **the port that is actually listening** — read it, do not assume:
`ss -tlnp | grep agentglass-serv`. It is :4000 when `obs` is not running.
The device needs **`read` scope or wider**; `answer` is not enough for
`/usage/providers`.

## Steps, and what each should show

1. **Open Home.** Under the connection line there is a card headed **Plan left**.
   Headline is a big percentage in colour, then `left of <Provider> · <window>`,
   then `resets <when>`, then one bar per window.
   *Before this branch there was no card at all — the phone could not tell you
   how much plan was left without opening the desktop.*

2. **Check the headline is the TIGHTEST window, not the first.** Compare against
   the desktop's Usage panel, or `curl -H "Authorization: Bearer $(cat
   ~/.config/agentglass/token)" http://127.0.0.1:<port>/usage/providers`. The
   number shown must be `100 - usedPercent` of whichever window is most used
   across all providers, and the label must name that provider and window.

3. **Colour.** Green with room, amber tightening, red nearly out. Driven by
   `quotaTone(usedPercent)`.

4. **The age line, top right of the card.** It qualifies the number — the server
   holds a reading for ~15 minutes and keeps the last good one for up to a day
   while Anthropic rate-limits, so a stale percentage otherwise looks live.

5. **Airplane mode / server down.** The card stays and says
   *"Cannot reach the computer"* — it does not vanish, does not show a stale
   number as if it were fresh, and **never prints an address or an exception**.
   The first QA run failed here: it rendered
   `fetch failed: java.net.ConnectException: Failed to connect to /127.0.0.1:4000`
   in the card and again in the status line above it. Fixed at the fetch
   boundary in `mobile/src/lib/api.ts`; `mobile/test/api-errors.test.ts` covers
   the six shapes Android produces and the address scrub.

6. **A machine with no quota-reporting agent** answers with the card saying
   *"No agent on this computer reports a plan quota."*

7. **Nothing else on Home moved.** The queue, the connection line and the tabs
   are untouched by this branch.

## Things that are NOT bugs

* **No card for the first second.** `planState` returns `loading` before the
  first answer lands and the card renders **nothing** — deliberately. An empty
  card that then fills in is a flash of wrong information.
* **The number does not change between two runs.** The server caches a reading
  for ~15 minutes; the phone polls every 5. It is meant to be a poll behind, not
  a cache behind.
* **Only one bar on this machine.** With a single provider reporting, the bars
  are labelled by window only (`5h`, `week`) rather than `Claude 5h` — the
  provider name on every row would be furniture.

## What is verified, and what is not

**Verified by me, no hardware:** rebase onto main clean; `npm run typecheck`
clean; `bun test` **387 pass / 0 fail** across 34 files, including
`test/quota.test.ts` and `test/api-errors.test.ts`.

**Verified by the previous owner, before the reboot:** `bun scripts/qa.ts` 9/9
screens against a scratch server, Home drawing real data (39% left of Claude,
5h, resetting in 3h 27m). That screenshot lived in `mobile/.qa-shots/` and is
gone — regenerate by re-running the sweep.

**Never run:** anything on a real device or emulator. The APK has never been
built from this branch. The web target uses the shims in `metro.config.js`, so
a passing `qa.ts` sweep is not evidence about Hermes.
