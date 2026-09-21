# Matchstick Labs — Service status

An independently hosted status page for the `plays/` demos and the Jev API that backs some of
them (`jev.matchstick.trading`). It lives here, in the public GitHub repository, specifically so
it still loads if Cloudflare — which hosts both the site and the Jev worker — has a problem.
This page is updated by hand. It is not automated monitoring, and a quiet page does not mean
every request in the last five minutes succeeded; it means no known incident is open.

## Current state

**No known incident.** All plays and the Jev API are expected to be operating normally.

## Affected surfaces

None.

## Detected

N/A — no active incident.

## Next review

N/A — no active incident.

## Contact

[hello@matchstick.trading](mailto:hello@matchstick.trading)

---

_Last updated: 2026-09-21._

## How this page works

- **Current state** — one of: operating normally, degraded (some plays still fully usable in
  deterministic/fixture mode), or unavailable.
- **Affected surfaces** — which play(s) or endpoint(s), by name.
- **Detected** — when the maintainer became aware of the issue, in UTC.
- **Next review** — an exact date/time the maintainer will next post an update here. This is a
  commitment to post an update, not a promise that the issue will be fixed by then.
- **Contact** — how to reach the maintainer about this page or an incident.

Support for these experiments is optional and never buys uptime, priority, or a particular
result — see each play's footer. For what each play is and why it exists, see the
[repository README](README.md).
