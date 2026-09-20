# Backtest Autopsy

45 synthetic backtest runs. Five have a real structural bug seeded in — lookahead leakage, a
timezone offset, a bad corporate-action adjustment, an event-ordering violation, or an impossible
fill — the rest are clean. Deterministic code always computes five cheap summary stats per run.
Jev looks only at those stats and guesses which failure family is most likely, before anyone pays
to run the one check that can actually confirm it.

## Running it

Serve the folder with any static server:

```sh
python3 -m http.server 8768 --directory plays/backtest-autopsy
```

Open `http://localhost:8768/`.

The demo loads synthetic fixture data from `fixtures/corpus.json` and calls the Jev autopsy
endpoint at `jev.matchstick.trading/api/autopsy` for family classification. If Jev is unavailable,
it falls back to a deterministic heuristic (pick the family behind the single hottest bucket).

## How it works

1. **Ingest** — load all 45 runs (60 daily bars + 8 orders each, synthetic).
2. **Diagnose** — code computes five bucketed diagnostics per run, always, at zero cost: how often
   orders used future-dated feature data, how many fills landed outside the trading session, the
   largest unexplained overnight price move, how many events are out of causal order, and how many
   fills are physically implausible.
3. **Triage** — each run's five bucketed diagnostics (never the raw data) are sent to Jev with one
   `choice` question over six labels (five failure families plus "clean"). Jev returns a top guess
   and a probability for every label.
4. **Display** — runs are ranked with flagged (non-clean) guesses first, highest confidence first.
5. **Run diagnostic** — per card, this executes the one deterministic check that can actually
   confirm the guessed family: a bounds check, a timestamp-ordering check, or a recorded-adjustment
   lookup. This is the only step that establishes a fact. Jev's guess is a triage prioritization,
   not a verdict — clicking it on a run Jev called "clean" spot-checks all five diagnostics, and
   will still catch a failure Jev missed.
6. **Reveal ground truth** — shows the seeded failure per run and scores the triage (accuracy,
   missed failures, false alarms, Brier score).

## Fixtures

All data is synthetic — no real securities, no real backtests.

Regenerate fixtures:

```sh
node fixtures/generate.mjs
```

The generator creates 45 runs: 6 each of 5 failure families (30) and 15 clean. Each failure is
injected with randomized severity (1-4 of 8 orders, or a randomized magnitude), so the bucketed
diagnostics span the full none/mild/notable/severe range rather than always being an obvious tell.

## Methodology

This is a triage classification experiment, not a backtest validator. Jev never sees raw run data
— only five bucketed summary statistics — and its job is to prioritize which of a fixed set of
deterministic checks is worth running, not to declare a verdict on its own. Ground truth is frozen
and synthetic. Success is measured by triage accuracy and calibration (Brier score) against seeded
labels, not by whether any flagged run "would have lost money."

Jev's probabilities are model-output triage scores for a fixed six-class question, not guarantees
that a check will confirm.
