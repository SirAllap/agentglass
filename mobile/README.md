# agentglass on a phone

A React Native companion for the machine agentglass is running on. It pairs
over your own wifi, shows the queue, the board, the pull requests and the
conversations, and attaches to the tmux panes that are already open on the
computer.

## Why this exists rather than the browser companion

The browser companion could never pair over a LAN address, and the reason is
one line in `web/src/lib/pairing.ts`: `crypto.subtle` only exists in a *secure
context*. A phone opening `http://192.168.1.20:4000` from the QR code therefore
has no WebCrypto, cannot generate the P-256 key the handshake is built on, and
the app's own diagnosis is to go and set up `tailscale serve` first.

@noble does P-256, HKDF and AES-GCM in pure JavaScript on Hermes, with no
secure context and no native module. So the same handshake works, unchanged,
over plain HTTP on your own network — and the server does not move: not a
route, not a field.

## Running it

Two processes, both local.

```bash
# the machine's own server, from the repository root
cd server && bun run src/index.ts

# Metro, from here
npm start -- --go --host lan
```

Then install **Expo Go** on the phone and open `exp://<this-machine>:8081`.

Expo Go has to match the SDK in `package.json`. The Play Store build lags, and
the SDK-matched ones are published at
`github.com/expo/expo-go-releases`.

Pair from **Settings ▸ Remote access** on the computer: scan the code, type the
six digits, accept the request there. For the terminal, accept it with the
**Everything** scope — `/terminal/pty` requires `full`.

**Alerts do not work in Expo Go**, and that is not a bug to chase. Expo Go
dropped `expo-notifications` on Android in SDK 53, so the module is simply
absent from the runtime — the app's Settings says so in as many words, "Not
available in this build" in red, and `src/notifications/notify.ts` calls that
state `unsupported`. The only way to see an alert on a phone is a real build.
That sentence is also the check that a build IS real: install an APK, pair, open
Settings, and if the Alerts card offers **This phone may buzz** with a green
box, the notifications module is in there.

## Building an APK

```bash
npm ci
npx expo prebuild --platform android --no-install   # writes mobile/android/
cd android && ./gradlew assembleDebug assembleRelease
```

Both land under `android/app/build/outputs/apk/`. Measured on 2026-08-08, cold:
prebuild 2s, Gradle 5m18s, `app-release.apk` 124 MB and `app-debug.apk` 254 MB.
They are that size because `gradle.properties` asks for all four ABIs and
nothing is minified; an `abiSplits` build or an app bundle is the lever if that
ever matters, and neither has been needed yet.

`assembleDebug` produces an APK that expects Metro on port 8081 — it is for
attaching a debugger to, not for handing to anybody. **The release APK is the
one to install and the one to test.**

Two traps, both measured here:

* **The JDK has to be a JDK.** React Native 0.86's Gradle plugins ask for a Java
  17 *toolchain*, and Gradle will not fall back. On this laptop the system
  `java` was a JRE with no `javac`, and the build died on
  `Toolchain installation '/usr/lib/jvm/java-21-openjdk-amd64' does not provide
  the required capabilities: [JAVA_COMPILER]` — pointing `JAVA_HOME` at a real
  JDK 17 was the whole fix.
* **`adb shell input text` is not a reliable way to fill the pairing form.** The
  emulator's stock keyboard opens a "Try out your stylus" tutorial over the
  screen and swallows everything after the sixth character; `10.0.2.2:4713`
  arrived as `10.0.2`. `adb shell ime disable <id>` for both IMEs first — `input
  text` injects into the focused view and does not need one.

## Signing a release build

The Expo template signs `release` with the debug keystore it checks into
`android/app/`. That is fine for handing somebody an APK to try, and wrong for
anything published: everyone who has ever run `expo prebuild` has that key, so
the signature proves nothing, Play rejects it, and — the part that bites later —
a properly signed update can never replace a debug-signed install, because
Android refuses an update signed by a different key.

`plugins/with-release-signing.js` fits the door. It runs inside `prebuild`, so
the generated tree already carries it, and it reads four values from the
environment (or from `~/.gradle/gradle.properties`, so nothing has to go in
shell history):

```
AGENTGLASS_ANDROID_KEYSTORE            path to the .jks
AGENTGLASS_ANDROID_KEYSTORE_PASSWORD   store password
AGENTGLASS_ANDROID_KEY_ALIAS           alias inside the store
AGENTGLASS_ANDROID_KEY_PASSWORD        key password
```

It never creates, writes or reads a keystore from the repository. With the four
set, Gradle prints `agentglass: signing release with <path>`; with them unset it
prints that it is falling back to the debug key and says the build is
installable but not publishable. Both branches were exercised on 2026-08-08:
with a throwaway keystore, `apksigner verify --print-certs` reported
`Signer #1 certificate DN: CN=agentglass throwaway`; without it, `CN=Android
Debug`. Check the file rather than the log — the log says what the build
intended, `apksigner` says what the APK carries.

Releases are built by `.github/workflows/android-apk.yml` from the repository
secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and
`ANDROID_KEY_ALIAS`, and that job refuses to publish a tag it cannot really
sign.

## Decisions worth knowing before you change something

**`legacy-peer-deps` in `.npmrc`.** Expo pins React to what the SDK was built
against while `expo-router` pulls a radix tree whose `react-dom` asks for a
newer one. Both are right and neither will move, so npm's strict resolution
refuses to add *any* dependency. It lives in a file rather than on a command
line so `npm ci` resolves the same tree as `npm install` on a laptop — the
`Install (mobile)` step of the `mobile` job in `.github/workflows/ci.yml`.

**`android/` is generated, not committed.** It is 552 KB of template that
`expo prebuild` writes from `app.json`, and committing it would make the
checkout a second source of truth that silently outranks the config — including
`plugins/with-release-signing.js`, whose whole existence is that it runs *inside*
prebuild. The argument for committing it is CI time, and that argument was
measured on 2026-08-08 rather than assumed: a cold prebuild takes **2 seconds**,
against 5m18s for the Gradle build behind it. Two seconds does not buy a second
source of truth. `.github/workflows/android-apk.yml` therefore prebuilds on
every run.

**`src/terminal/engine.generated.ts` is generated, not committed.** A WebView
has no bundler and no network, so xterm is compiled into a string by
`scripts/build-terminal-engine.mjs` and inlined into the terminal document.
`postinstall` regenerates it. Committing 380KB of minified engine would put it
in the diff of every dependency bump with nobody able to tell whether it
matches `package.json`.

**Typed routes are off.** They are generated by Metro into `.expo/types`, and
this project type-checks *without* Metro running — in the `mobile` job of
`.github/workflows/ci.yml` and in `npm run typecheck`. The generated union goes
stale the moment a screen is added, and `tsc` then rejects a route that exists
on disk. What that buys is catching a typo'd path; what it costs is a
type-check whose correctness depends on a dev server having been started.

**Two tsconfigs.** The app runs on Hermes and is typed against React Native;
the tests run under `bun test` and reach for `Bun.spawn`, `process` and
`node:fs` to boot a real server. TypeScript's `types` field replaces rather
than adds, so one file cannot describe both. `web/tsconfig.test.json` was
copied from this shape afterwards, for the same reason.

**TypeScript is `~6.0.3` here and `5.9.3` in `web/` and `server/`.** The repo's
two halves were pinned together after `bunx tsc` was caught installing 7.0.2
into `server/` — undeclared, so the newest published — while `web/` compiled the
same `shared/types.ts` with 5.9.3. This project is not in that pin: it installs
with npm from its own lockfile against the Expo SDK template, which is where its
TypeScript version comes from. `~` is a patch range, so the failure that pinning
prevents (a major arriving on its own) cannot happen here either. Measured on
2026-08-07: both configs here type-check clean under 5.9.3 as well, so aligning
is a one-line change in `package.json` whenever the SDK's own version map says
it is safe.

**Metro watches `../shared` and `../web/src`.** `shared/` is the wire — the
same `types.ts` the server compiles against. `web/src/mobile/` is the browser
companion's *model* layer: what counts as waiting on you, how a chat list is
assembled, which pull-request rows are the same one. Fourteen of those sixteen
files touch no DOM, they are already tested in `web/test/`, and two companions
disagreeing about what "blocked" means is worse than an import that points
sideways. When the browser companion goes, they move in here with their tests.

## Testing

```bash
npm test          # bun, including two suites that boot a real server
npm run typecheck # the app and the tests, separately
```

Both run on every push and pull request, in the `mobile` job of
`.github/workflows/ci.yml`, after an `npm ci` here and a `bun install` at the
root. The root install is there because the two suites below spawn the real
server: without it bun quietly auto-installs the server's imports at runtime and
ignores `bun.lock` — measured, `@anthropic-ai/sdk@0.115.0` against a lockfile
pinning `0.112.1`. `make mobile-test` runs the same three commands.

`test/pairing-e2e.test.ts` and `test/fleet-shapes.test.ts` start
`server/src/index.ts` for real. They point `XDG_CONFIG_HOME` at a temp
directory, and that is not tidiness: without it the pairing suite appends
working credentials to your own `~/.config/agentglass/devices.json`, which
happened once and had to be picked back out by hand.

`server/test/tmux-attach.test.ts` starts a real tmux server on its own socket
to check that attaching a phone does not resize the session on your desk.
