#!/usr/bin/env python3
"""PTY bridge for agentglass's in-browser terminal.

Runs a shell inside a real pseudo-terminal (so the browser gets a *machine*
terminal: job control, colors, cursor addressing, vim/htop/lazygit all work)
and shuttles raw bytes between the pty and this process's stdin/stdout, which
the Bun server pipes to the browser over a WebSocket.

Window resizes arrive out-of-band: the server writes "rows cols" to the file
named by $AGENTGLASS_PTY_SIZE_FILE and sends this process SIGWINCH; the
handler applies it to the pty (TIOCSWINSZ) and forwards SIGWINCH to the shell.
Stdlib only — no dependencies.
"""
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


# Signals CPython sets to SIG_IGN for its own convenience at interpreter
# startup. An ignored disposition is one of the few things that survives
# execve, so without this the user's shell — and every command they run in the
# panel — would start with SIGPIPE ignored, which a real terminal never does.
# The visible symptom is a pipeline whose reader exits early (`history | sed
# -n 1p`, `... | head`): instead of the writer dying quietly on SIGPIPE it gets
# EPIPE back and prints "write error: Broken pipe".
_INHERITED_IGNORES = ("SIGPIPE", "SIGXFSZ", "SIGXCPU", "SIGTTIN", "SIGTTOU")


def reset_signals() -> None:
    """Hand the shell the clean signal slate a terminal emulator would."""
    for name in _INHERITED_IGNORES:
        sig = getattr(signal, name, None)
        if sig is None:
            continue  # not on this platform
        try:
            signal.signal(sig, signal.SIG_DFL)
        except (OSError, ValueError):
            pass  # unresettable here — better a stray ignore than no shell


def write_all(fd: int, data: bytes) -> None:
    """Write every byte, or raise.

    `os.write` returns how many bytes it actually took, and it is allowed to
    take fewer than it was given. Both ends of this bridge can do that: a pty
    master's input buffer is a few KB while the reads above ask for 64, and a
    write that has already moved some bytes when a signal lands returns that
    short count rather than EINTR — so Python's own EINTR retry cannot help,
    and this process installs a SIGWINCH handler, which is exactly the signal
    that arrives while somebody is dragging the panel wider.

    A bare `os.write` discards the remainder silently. There is no error and
    nothing in the log: the paste is simply missing its tail, or a repainting
    full-screen program comes back with a hole in the middle of its frame.
    """
    while data:
        n = os.write(fd, data)
        if n <= 0:  # nothing moved and no exception — nothing left to try
            break
        data = data[n:]


def main() -> int:
    cmd = sys.argv[1:] or [os.environ.get("SHELL", "bash"), "-i"]
    size_file = os.environ.get("AGENTGLASS_PTY_SIZE_FILE", "")

    pid, fd = pty.fork()
    if pid == 0:  # child: become the shell, attached to the pty slave
        reset_signals()
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:
            sys.stderr.write(f"agentglass pty: cannot exec {cmd[0]}: {e}\n")
            os._exit(127)

    def apply_size(*_sig) -> None:
        try:
            rows, cols = open(size_file).read().split()[:2]
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
            # The whole foreground group, not just the shell.
            #
            # The shell is rarely what needs telling: a full-screen program —
            # tmux, vim, htop — is running as its child, and bash does not
            # forward SIGWINCH to it. Signalling only the shell left tmux
            # convinced the terminal was still the size it was at attach, so it
            # kept drawing to the old width and the extra columns showed up as
            # a dead band down the right of the panel.
            #
            # The group is the reliable target: TIOCSWINSZ on the master should
            # already make the kernel signal the slave's foreground group, but
            # that depends on which end owns the tty and on the shell being a
            # session leader — conditions that vary with how the shell was
            # spawned. Sending it explicitly costs nothing and does not.
            try:
                os.killpg(os.getpgid(pid), signal.SIGWINCH)
            except Exception:
                os.kill(pid, signal.SIGWINCH)  # no group (or it is gone) — shell only
        except Exception:
            pass  # size file missing/garbled — keep the old size

    if size_file:
        signal.signal(signal.SIGWINCH, apply_size)
        apply_size()

    while True:
        try:
            ready, _, _ = select.select([fd, 0], [], [])
        except InterruptedError:  # SIGWINCH landed mid-select
            continue
        except OSError:
            break
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:  # shell exited → pty master raises EIO
                break
            if not data:
                break
            write_all(1, data)
        if 0 in ready:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b""
            if not data:  # server hung up — tear down
                break
            write_all(fd, data)

    try:
        os.close(fd)
    except OSError:
        pass
    try:
        _, status = os.waitpid(pid, os.WNOHANG)
        if status == 0 and _ == 0:  # still running (server hangup path): end it
            os.kill(pid, signal.SIGHUP)
            _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        return 0
    if hasattr(os, "waitstatus_to_exitcode"):
        return os.waitstatus_to_exitcode(status)
    return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)


if __name__ == "__main__":
    sys.exit(main())
