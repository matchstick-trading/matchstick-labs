# AGENTS.md

Instructions for any agent (Claude Code, Codex, or other) working in this repository.

## This repo is public on purpose — issues are for user feedback, not internal planning

`matchstick-labs` is public specifically to gather reactions and feedback from real users on
the `plays/` demos. That flips the usual GitHub hygiene rule:

- **Never open a public issue for internal milestone/gate work** (the M-series: M8, M9,
  M10...). Track that in the private "Matchstick Labs (internal)" org project instead —
  `gh project item-list 2 --owner matchstick-trading` (project #2,
  `PVT_kwDODoVduM4BjfWl`). Add a draft item there, or link it to the relevant Forage ticket
  (`.forage/tickets/vaults.DEV-*.md` with `project: matchstick-labs` in the Vaults repo) — no
  public issue needed.
- **A real user's issue is real signal — treat it as such.** Acknowledge it, triage it, and
  cross-reference a Forage ticket if one gets opened for the work, but never delete it and
  never paste internal specifics (Forage ticket bodies, milestone/gate names, other users'
  info) into a public comment.
- **If internal planning ends up in a public issue anyway**, migrate its substance to the
  private project and close the issue with an explanatory comment — don't leave it sitting
  there, and don't reach for deletion as the routine fix (see the incident below for why).

**Incident, 2026-09-14:** internal M8 Gate A planning was filed as public issue #1 before
anyone caught it, then deleted outright (irreversible) once caught, rather than migrated with
a comment. The private project now holds that content as a draft item. A `tpm` subagent
(`.claude/agents/tpm.md`) exists to catch this drift going forward — run it periodically, or
whenever a new public issue looks like it might be internal planning rather than user
feedback.
