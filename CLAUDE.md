# Working in this repository

Rules that cost something the day they were broken. They are short because
each one is a scar, not a preference.

## This repository is public

Everything below follows from that one fact.

- **No private conversation ever reaches a file, a commit message, a pull
  request body, or a comment on one.** Not quoted, not translated, not
  paraphrased with "reported by". A comment owes the next reader the defect and
  how it was measured; who mentioned it, and in what words, is not
  documentation. Write "the strip did not follow the computer", never "somebody
  said the strip did not follow the computer".
- **No real names.** Not in a comment, not in an example, not in test data.
  Chat notifications and task boards carry other people's names — replace them
  with a placeholder before the example goes in.
- **No links to an assistant session.** They are private URLs and they belong
  in nobody's git history. The GitHub tooling can append one to a pull request
  body when the pull request is CREATED: after opening one, read the body back
  and strip it. Editing a body never adds one.
- **One signature per pull request body, at most.** Two is what happens when a
  footer is written by hand and appended by a tool as well.
- **Nothing in the tree that is not the change.** No design notes, no scratch
  files, no implementation plans, no screenshots of a conversation. A working
  document lives outside the repository.

`bun test` in `server/` runs `test/private-content.test.ts`, and it fails the
build rather than trusting anybody to remember. It checks two of the five:

  the session links, which are a fixed shape;
  and a quoted conversation, by language — this codebase is written in
  English, so three distinct Spanish function words inside one pair of quotes
  in a comment is not an accident. The comment is flattened first, because a
  quote wrapped across two lines is one quote to a reader.

**A real name it cannot check**, and pretending otherwise is worse than saying
so: there is no scan that separates a person from an identifier. That one rests
on whoever writes the example, and the place it has come from every time is a
chat notification or a task board open on the other screen.

The other two — a paraphrase with "reported by", and a working document
committed by accident — are the same: read before you commit, because nothing
here will stop you.

## Commits

- End the message with `Co-Authored-By:` and nothing else. No session trailer.
- One reason per commit, and the message says why rather than what — the diff
  already says what.

## Tests

- A test's fixture should be the shape of something real, and its comment
  should say what went wrong without saying who it went wrong for.
- Prefer pulling a decision out of a screen and testing it there. There is no
  renderer in this project, and a rule about source is asserted against source.
