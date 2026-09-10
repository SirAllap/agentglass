"""Strip the private session link from a commit message on stdin.

ONLY that. An earlier version of this also tried to remove quoted Spanish and
was run through a shell heredoc, which took stdin away from it: every message
came out empty and all 108 were rewritten to nothing. What `--msg-filter`
prints IS the message, so a filter that prints nothing deletes everything.

So this does one mechanical thing, is fed the message on stdin, and refuses to
print an empty message: if the input had text and the output does not, the
commit keeps what it had rather than losing it.
"""
import re
import sys

body = sys.stdin.read()
out = re.sub(r"(?m)^[ \t]*Claude-Session:.*$\n?", "", body)
out = re.sub(r"https?://claude\.ai/code/session[_/][A-Za-z0-9]+", "a session", out)
out = out.rstrip() + "\n"
sys.stdout.write(body if (body.strip() and not out.strip()) else out)
