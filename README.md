# matchstick-labs

A playground for small, playful interaction experiments around market data — built by one person
(a former trading-platform product manager) exploring new ways to control and browse a replay,
outside of any product roadmap or ship date.

This is **not** the Matchstick Replay product. Nothing here is a feature, a commitment, or a
preview of what's shipping — it's early R&D, one idea per folder under `plays/`, kept because it's
fun to play with and interesting to show.

## Plays

- [`tape-and-ladder`](plays/tape-and-ladder/) — walk the price tape as terrain, climb the order
  book as a ladder. An arcade answer to "what if browsing data felt physical instead of visual?"
- [`find-the-moment`](plays/find-the-moment/) — describe a market episode in plain language.
  Deterministic code searches synthetic fixtures, Jev ranks the shortlist, you reveal ground truth.
- [`backtest-autopsy`](plays/backtest-autopsy/) — 45 synthetic backtests, five with a seeded bug.
  Deterministic code always computes cheap diagnostics; Jev triages which one check to run next.
- [`market-data-incident-lab`](plays/market-data-incident-lab/) — 45 synthetic feed runs, five
  with a seeded incident, five with a genuine news move as a deliberate trap for Jev's triage.

## Why public

These are meant to be played, shared, and reacted to — not filed away. If one of these ideas ever
grows into a real product feature, that conversation happens separately and explicitly; nothing
here should be read as a promise that it will.
