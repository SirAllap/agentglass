#!/bin/sh
# The plan meters, fed for free.
#
# Claude Code pipes `rate_limits` to the statusLine command on every turn,
# piggybacked on the Messages API response it already made. Forwarding that
# costs nothing against /api/oauth/usage, an endpoint tight enough to answer 429
# to a third call inside four minutes — so this is the cheap source, and the
# poll in server/src/usage.ts is the fallback for when no session is running.
#
# Two things shape every line below.
#
# 1. This runs on EVERY status line tick — several times a second while a reply
#    streams. So the common path is shell builtins only: the `rate_limits` guard
#    and the throttle both decide before anything is spawned.
#
# 2. Whatever status line was here before us is CHAINED, not replaced. Its
#    command arrives as $1, gets the same stdin, and owns stdout; this script
#    prints nothing of its own. Getting that wrong means the user loses their
#    status line in every Claude Code session, so every early exit below still
#    runs the chain.

payload=
while IFS= read -r agx_line || [ -n "$agx_line" ]; do
  payload="$payload$agx_line
"
done

# The chained status line. Runs last so its output is the whole of ours, and
# runs on every path out of here — including the failures.
agx_chain() {
  [ -n "$1" ] || return 0
  printf '%s' "$payload" | sh -c "$1"
}

# `rate_limits` shows up only for subscriber sessions, and only once the session
# has had an API response. Anything else is a tick with nothing to say, which is
# most of them.
case "$payload" in
  *'"rate_limits"'*) ;;
  *) agx_chain "$1"; exit 0 ;;
esac

# One post per interval for the whole machine, not per session: these numbers
# are account-wide, so the first session to arrive speaks for all of them.
agx_stamp="${TMPDIR:-/tmp}/agentglass-statusline-stamp"
agx_now=$(date +%s 2>/dev/null) || agx_now=
# A leading zero reads as octal inside $(( )), and a bad octal constant is FATAL
# in dash — the script would die here, before the chain, and the user's status
# line would go dark. Allow-list canonical decimals so anything odd fails open.
case "$agx_now" in 0|[1-9]|[1-9][0-9]*) ;; *) agx_now= ;; esac
if [ -n "$agx_now" ] && [ -f "$agx_stamp" ]; then
  agx_last=
  IFS= read -r agx_last < "$agx_stamp" 2>/dev/null || :
  case "$agx_last" in 0|[1-9]|[1-9][0-9]*) ;; *) agx_last= ;; esac
  if [ -n "$agx_last" ]; then
    agx_elapsed=$((agx_now - agx_last))
    # A clock that stepped backwards gives a negative elapsed; treat it as due
    # rather than locking the feed out until wall time catches up.
    if [ "$agx_elapsed" -ge 0 ] && [ "$agx_elapsed" -lt 15 ]; then
      agx_chain "$1"
      exit 0
    fi
  fi
fi

agx_server="${AGENTGLASS_SERVER:-http://127.0.0.1:${AGENTGLASS_PORT:-4000}}"
agx_token="$AGENTGLASS_TOKEN"
if [ -z "$agx_token" ]; then
  # The token file rather than the environment: a status line inherits the
  # environment of whatever launched Claude Code, which for a desktop icon is
  # nothing at all. Same file the server reads, owned by the same user.
  agx_token_file="${XDG_CONFIG_HOME:-$HOME/.config}/agentglass/token"
  if [ -r "$agx_token_file" ]; then
    IFS= read -r agx_token < "$agx_token_file" 2>/dev/null || agx_token=
  fi
fi

# One curl invocation with the header in a variable: `${t:+-H "Authorization:
# Bearer $t"}` word-splits in POSIX sh and would send the header in pieces. The
# harmless default keeps it to a single code path — the route needs no token
# when the server was started without one.
agx_auth="Accept: application/json"
[ -n "$agx_token" ] && agx_auth="Authorization: Bearer $agx_token"

# Stamped only when a post is actually about to happen, so a skipped tick never
# pushes the next allowed one further out.
[ -n "$agx_now" ] && printf '%s' "$agx_now" > "$agx_stamp" 2>/dev/null

# Backgrounded: the status line must not wait on a socket. Localhost answers in
# single-digit milliseconds, far inside the time the chained command takes to
# spawn, and the timeouts bound the pathological case.
printf '%s' "$payload" | curl -sS -X POST "$agx_server/statusline" \
  --connect-timeout 0.3 --max-time 1.0 \
  -H "Content-Type: application/json" \
  -H "$agx_auth" \
  --data-binary @- >/dev/null 2>&1 &

agx_chain "$1"
exit 0
