# Flatpak build and a self-hosted update channel

**Date:** 2026-08-25
**Status:** approved

## What this is

A Flatpak of the desktop app, and an OSTree repository published to this
project's existing GitHub Pages site so `flatpak update` works. It sits beside
the AppImage and `.deb` that `desktop-binaries.yml` already produces; it
replaces neither.

Everything here is self-contained: one repository, `github.token` only, no
signing key, no second repository, no personal access token, and no third-party
action that is not already used elsewhere in `.github/workflows/`. A maintainer
merging this has nothing to provision and no repository setting to change.

## The thing to understand first

agentglass supervises tools that live on the **host**: `server/src/deps.ts`
resolves `claude`, `git`, `docker`, `gh`, `codex`, `agy` and the rest with
`Bun.which()`, and the terminal opens the user's real login shell. A Flatpak
sandbox has none of those.

So this Flatpak is deliberately **not** a security boundary. It carries
`--filesystem=host` and `--talk-name=org.freedesktop.Flatpak`, and the second
of those is a full sandbox escape — it is what lets the app run host processes
at all. It is the same hole VS Code's Flatpak carries, for the same reason, and
without it the app boots and reports every dependency missing.

That is stated here, in the install docs, and in the manifest itself, rather
than left for a user to infer from a permission list. Someone installing a
Flatpak has a reasonable expectation of confinement, and this one does not
provide it. Saying so is the whole of the mitigation; there is no version of
this app that supervises host agents from inside a sandbox.

`flatpak override` can narrow it afterwards, and the app degrades honestly when
narrowed — the deps panel says what it cannot reach.

## Facts this design rests on

Measured against flatpak 1.18.1 and `org.freedesktop.Platform//25.08`, not
assumed. Two of these contradicted the first draft of this design.

| Need | Result |
|---|---|
| Host binaries from the sandbox | `flatpak-spawn --host git --version` → `2.55.0` |
| Working directory mapping | 1:1 under `--filesystem=host`; sandbox `pwd` == host `pwd` |
| Exit-code propagation | `sh -c 'exit 7'` → `7` |
| **PTY onto a host shell** | Works. Full interactive host `fish`, prompt, colours, correct cwd |
| `python3`, `setsid`, `script`, `bash`, `xdg-open` | Present in the runtime — must **not** be shimmed |
| `tmux` | Absent from the runtime. Already bundled by `build-tmux-static.sh`, so it ships in-sandbox |
| `dbus-monitor` | Absent from the runtime. Needs a host shim |
| `$SHELL` passed into the sandbox | **No.** Forced to `/bin/sh` |
| Stripping the compiled sidecar | **Fatal.** Reverts it to the plain `bun` CLI |
| Published repo size, one release | 178 MB, after prune and static deltas |

The PTY result is the one the terminal depends on; had it failed, this design
would not exist. The `$SHELL` result would have silently broken the terminal
for every user whose login shell is not bash.

### Two things only the build could tell us

Both would have shipped a Flatpak that installs cleanly and does not work.

**flatpak-builder strips every ELF it exports, and that destroys the sidecar.**
`bun build --compile` produces an ELF with the application appended *after* it.
Stripping rewrites the ELF and discards the appended payload. The binary still
runs, which is what makes it nasty: it silently reverts to being the plain `bun`
CLI and prints bun's help text, so the window opens onto a backend that never
starts. The manifest therefore sets `strip: false` and `no-debuginfo: true`.
Measured before choosing: stripping this tree reclaims about 49 KB in total,
because Electron ships its binaries stripped already and the tmux build is
static and small — so the fix costs essentially nothing.

This also retires the argument, made in an earlier draft of this document, for
keeping `--disable-debuginfo` off in order to preserve a stripped app ref. There
is no stripped app ref to preserve; there is only a working sidecar or a broken
one.

**A distro-packaged bun makes a sidecar that cannot run in the runtime.** The
Arch `bun` package is dynamically linked against the system ICU and stamps that
onto everything it compiles, so the sidecar dies inside the sandbox with
`libicui18n.so.78: cannot open shared object file`. The official bun that
`oven-sh/setup-bun` installs links no ICU at all, so CI is unaffected — but a
contributor building locally will hit it, which is why `make flatpak` carries
the diagnosis in a comment.

Both failures are caught by the CI smoke test's `/health` check, which is the
argument for that check existing at all.

## Non-goals

- **Flathub.** A submission is a separate process with a review layer, and the
  sandbox hole above would have to be argued there on its own merits.
- **aarch64.** The Linux matrix in `desktop-binaries.yml` is x86_64 only; this
  matches it. Adding an arch later is a matrix row and a merge loop.
- **Signing.** A signed repo needs a key the upstream maintainer generates and
  stores as a secret — that is precisely the kind of provisioning this design
  refuses to require. Users add the remote with `--no-gpg-verify` and the
  install docs say plainly what that costs them. Signing is additive later and
  does not change any other decision here.

## Architecture

### Packaging: a hand-written manifest

electron-builder 26 ships a `FlatpakTarget`, and it is not used. It defaults to
runtime `org.freedesktop.Platform` **20.08** — long EOL and gone from Flathub,
so it fails outright — and it depends on `@malept/flatpak-bundler`, archived
upstream since 2022. It also produces a single bundle rather than a repository,
and gives no clean way to inject the shim layer below.

Instead `electron-builder --linux dir` produces `electron/dist-app/linux-unpacked`
exactly as it already does on the way to the AppImage, and a small
`flatpak-builder` manifest copies that tree in as a single module. The app is
built by the pipeline that already exists; the manifest only packages it.

Base is `org.electronjs.Electron2.BaseApp//25.08`, and the app launches through
`zypak-wrapper` so Electron's sandbox works inside the Flatpak.

### Finish args

```
--socket=wayland --socket=fallback-x11 --share=ipc --device=dri
--socket=pulseaudio --share=network
--filesystem=host
--talk-name=org.freedesktop.Flatpak          # the escape; see above
--talk-name=org.freedesktop.Notifications
```

No `--socket=session-bus`. The one feature that wants it is notification
mirroring onto the notch, which needs `dbus-monitor`; shimming that to the host
gets the feature working without a permission that reads broader than it is.

### The shim layer

`/app/hostbin` is prepended to `PATH` and holds one script per host tool:

```sh
#!/bin/sh
exec flatpak-spawn --host <tool> "$@"
```

The list is **generated at build time from `DEPS` in `shared/deps.ts`**, minus
an explicit in-sandbox set (`python`, `tmux`, `setsid`, `script`, `opener`,
`bash`). Deriving it rather than hand-maintaining it is the point: when a fourth
agent CLI is added to `deps.ts`, a hand-written list would silently omit it and
the Flatpak would report it missing forever, with nothing to point at. A stale
list here is invisible; a generator cannot go stale.

The in-sandbox set is not an optimisation. `python3` backs the terminal's
pseudo-terminal and must create the PTY **inside** the sandbox — shimming it to
the host would break the terminal, not improve it.

### The wrapper

`/app/bin/agentglass`, the manifest's `command`:

1. `TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"`.
2. Prepend `/app/hostbin` to `PATH`.
3. Recover the real login shell — flatpak clobbers `$SHELL` to `/bin/sh`, so it
   is read back with `flatpak-spawn --host getent passwd "$(id -u)"`, stored in
   `AGENTGLASS_HOST_SHELL`, and `SHELL` is pointed at `/app/hostbin/hostshell`,
   which execs it on the host. This also fixes the bundled tmux, which takes its
   `default-shell` from `$SHELL` and would otherwise open sandbox shells with no
   agent CLIs in them.
4. Stage the hook forwarder to a host-visible path (below).
5. `exec zypak-wrapper /app/agentglass/agentglass "$@"`.

Step 3 falls back to `/bin/sh` if the lookup fails, so a wrapper that cannot
reach the host still starts an app that reports why.

### Three places the code assumes it can be reached from the host

These are not sandbox friction to be worked around in packaging — they are
points where the app writes something the **host** must later read or execute,
and a path inside `/app` is wrong there. Each is a few lines and each follows a
precedent already in that file.

**1. `hooksetup.ts` — the hook forwarder.** `hookCommand()` writes an absolute
path to `send_event.py` into the host's `~/.claude/settings.json`. `hooksDir()`
resolves it beside the sidecar, which inside a Flatpak is `/app/...` — a path
host Claude Code cannot open. Live session streaming, which is the app's
headline feature, would be silently dead.

The existing `|| exit 0` in `hookCommand` is what keeps this merely broken
instead of catastrophic: python exits 2 on a script it cannot open, and Claude
Code reads 2 from a `PreToolUse` hook as *deny this tool call*. Without that
guard a Flatpak install would have blocked every tool call on the machine.

*Change:* `hooksDir()` gains `process.env.AGENTGLASS_HOOKS_DIR` as its first
candidate. The wrapper copies `hooks/` to `$XDG_DATA_HOME/agentglass/hooks` — a
path identical inside and outside the sandbox — and exports it. The copy is
`cp -a src/. dest/`, an overwrite in place: idempotent, safe to run twice, and
with no window where the directory is missing for a host hook firing mid-launch.

**2. `selfupdate.ts` — the update button.** `updateStatus()` would find a newer
tag and offer an update that `self-update.sh` cannot perform, because `/app` is
read-only. An update button that breaks the install is worse than no button.

*Change:* block under `FLATPAK_ID`, pointing at
`flatpak update app.agentglass.desktop`. `windowsUpdateBlock()` is the existing
precedent for exactly this shape.

**3. `electron/main.js` — Linux autostart.** `autostartEnabled()` writes
`~/.config/autostart/agentglass.desktop` with `Exec=` set to `process.execPath`,
which under Flatpak is `/app/agentglass/agentglass` — not launchable from the
host session.

*Change:* under `FLATPAK_ID`, write `Exec=flatpak run app.agentglass.desktop`.

Everything else that reads `dirname(process.execPath)` — `claudemodels.ts`,
`browseruse.ts`, `tmuxbin.ts`, `tasks.ts`, `build-info.json` — is read by the
server in-sandbox and is correct unchanged.

### Publishing

The Pages source for this repository is **GitHub Actions** (`pages.yml` uses
`actions/deploy-pages`). A repository gets one Pages source, so the usual
`gh-pages`-branch pattern for an OSTree repo is not available here, and a
`deploy-pages` run replaces the published site wholesale — which would strand
every existing install on a repo whose history had vanished.

So the OSTree repo accumulates on an orphan `flatpak-repo` branch, and
`pages.yml` gains one step that lays it under `site/flatpak/` before uploading.
After publishing, `flatpak.yml` runs `gh workflow run pages.yml` so the new
build is live without waiting for the next push to `main` — `pages.yml` already
carries `workflow_dispatch`, so this needs no change to how it is triggered.

The cost, stated plainly because it lands on a maintainer who did not ask for
it: every push to `main` then carries the OSTree repo in the Pages artifact.
The step no-ops until `flatpak-repo` first exists, so nothing changes until the
first tagged release. Size is held down by `--prune-depth`, by dropping `.Debug`
refs, and by `--generate-static-deltas` so `flatpak update` fetches a diff
rather than the whole app.

Measured, by running the publish path locally against a real build: **178 MB**
for one release. Most of that is the first commit's from-scratch static delta,
which is the price of `flatpak update` fetching diffs afterwards. At
`--prune-depth=3` a steady state of roughly 400–500 MB is the number to plan
for, against Pages' 1 GB soft cap. `--prune-depth` is the knob if it gets
close.

Serving the repo from `raw.githubusercontent.com` would avoid touching
`pages.yml` entirely. It is rejected: an undocumented, rate-limited endpoint is
not a foundation for someone's update channel.

Every URL — the `.flatpakrepo`, the remote, the install line in the docs — is
derived from `${{ github.repository_owner }}` and the repository name at build
time, never hardcoded. That is what lets the whole pipeline, publish step
included, be proven on a fork before the PR is opened.

### Triggers

| Event | What runs |
|---|---|
| PR touching `electron/`, `web/`, `server/`, `shared/`, `packaging/` | Build, install, launch smoke test. No publish. |
| `v*` tag | Build, smoke, publish to `flatpak-repo`, redeploy Pages, attach `.flatpak` bundle to the release |
| `workflow_dispatch` | Build and smoke; publish only when asked |

Publishing on tags only keeps the repo growing per release rather than per
commit. The bundle on the release is for people who will not add a remote.

`flatpak.yml` carries its own copy of the build prerequisites (`bun install`,
web build, sidecar compile, zig, static tmux, provenance stamp) rather than
sharing them with `desktop-binaries.yml`. This matches the house pattern —
`android-apk.yml` does the same — and keeps a new packaging format from being
able to strand a release build. The drift risk is real and noted: a change to
how the sidecar is compiled must be made in both places. A local composite
action is the obvious fix if that bites.

## Files

| Path | What |
|---|---|
| `packaging/flatpak/app.agentglass.desktop.yml` | The manifest |
| `packaging/flatpak/app.agentglass.desktop.metainfo.xml` | AppStream, so the app appears in software centres |
| `packaging/flatpak/app.agentglass.desktop.desktop` | Desktop entry |
| `packaging/flatpak/agentglass-wrapper.sh` | Launch wrapper |
| `packaging/flatpak/hostbin.ts` | Shim generator, reads `shared/deps.ts` |
| `.github/workflows/flatpak.yml` | Build, smoke, publish |
| `.github/workflows/pages.yml` | One step: lay `flatpak-repo` under `site/flatpak/` |
| `server/src/hooksetup.ts` | `AGENTGLASS_HOOKS_DIR` candidate |
| `server/src/selfupdate.ts` | Flatpak update block |
| `electron/main.js` | Flatpak-aware autostart `Exec=` |
| `README.md` | Install instructions, including what the sandbox does not do |

## Testing

The full toolchain is available locally, so this is proven before any CI is
written, not after:

1. Build the Flatpak from the manifest.
2. Install it and launch it.
3. Confirm the deps panel resolves host `git` and `claude` through the shims.
4. Open the terminal and confirm it is the host login shell in the right cwd.
5. Toggle autostart and confirm the written `Exec=` launches from the host.
6. Confirm the update pane says Flatpak-managed rather than offering an update.
7. Install hooks and confirm host Claude Code can execute the staged forwarder.
8. Record the built repo size in this document.

Steps 1–4 and the sidecar check ran locally and pass, 14 assertions in all,
including a host `git` reached through a shim, `hostshell` resolving the real
login shell (`/bin/fish`), cwd mapping 1:1, and the sidecar answering `/health`
from inside the sandbox. The publish path — `build-commit-from`, `.Debug`
filtering, `build-update-repo --prune --generate-static-deltas` — was exercised
against a scratch repo rather than left for its first run to be in CI.

Two things could not be proven on this machine and are covered in CI instead:
the **bundled tmux**, which needs the zig cross-toolchain that produces it, and
the **GUI launch**, which is deliberately not attempted headlessly because it
would test the runner's display stack more than the package.

In CI the smoke test is step 2 plus a headless launch that must reach the
sidecar's health endpoint, matching what `desktop-binaries.yml` already does for
the tmux binary.

## Risks

- **The sandbox hole is the design.** Documented everywhere it is user-visible.
  There is no mitigation beyond honesty and `flatpak override`.
- **Pages artifact size.** Measured before shipping; `--prune-depth` is the
  control knob if it grows.
- **Prerequisite drift** between `flatpak.yml` and `desktop-binaries.yml`.
  Accepted deliberately over coupling a release build to a new format.
- **Unsigned repo.** Anyone who can write the Pages branch can serve an
  arbitrary app. Stated in the install docs; signing is additive.
