# Security Policy

agentglass is a **local-first developer tool**: the server is designed to run on
`localhost` (or a trusted LAN) and can stage/commit/push git, control Docker,
and open real shells on the machine it runs on. Treat the server port like you
would treat `sshd` on your workstation — do not expose it to the public
internet.

## Supported versions

Only the latest `main` is supported. There are no LTS branches; fixes land on
`main` and ship immediately.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting instead:
**[Report a vulnerability](https://github.com/SirAllap/agentglass/security/advisories/new)** —
it opens a private thread with the maintainer.

Please include:

- What an attacker can do, and from where (same machine · LAN · a webpage the
  user visits — e.g. anything that bypasses the origin guard on mutating routes)
- Steps or a proof-of-concept to reproduce
- The commit/version you tested

You can expect an acknowledgement within a few days. Once a fix ships, the
report can be published as an advisory with credit to you (unless you prefer to
stay anonymous).

## Hardening knobs

Every write surface can be disabled independently via environment variables:
`AGENTGLASS_TERMINAL_DISABLED`, `AGENTGLASS_CHAT_DISABLED`,
`AGENTGLASS_GIT_WRITE_DISABLED`, `AGENTGLASS_DOCKER_WRITE_DISABLED`,
`AGENTGLASS_COMMIT_DISABLED` — see the README's configuration table.
