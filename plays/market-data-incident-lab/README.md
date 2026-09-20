# Market Data Incident Lab

45 synthetic tick/quote feed runs. Five have a real structural incident seeded in — a frozen
quote, a crossed book, a duplicate print, an out-of-order print, or an unadjusted split — 10 are
quietly clean, and 5 are clean but carry a genuine, explained price jump (an earnings move or
halt/resume) with no other symptom. That last group is the trap: to a bare price-jump statistic, a
real news move and an unadjusted split look identical. Deterministic code always computes five
cheap summary stats per run. Jev looks only at those stats and guesses which incident family is
most likely, before anyone pays to run the one check that can actually confirm it.

## Running it

Serve the folder with any static server:

```sh
python3 -m http.server 8769 --directory plays/market-data-incident-lab
```

Open `http://localhost:8769/`.

The demo loads synthetic fixture data from `fixtures/corpus.json` and calls the Jev incident
endpoint at `jev.matchstick.trading/api/incident` for family classification. If Jev is
unavailable, it falls back to a deterministic heuristic (pick the family behind the single hottest
bucket).

## How it works

1. **Ingest** — load all 45 runs (50 trade prints + 50 quote updates each, synthetic).
2. **Diagnose** — code computes five bucketed diagnostics per run, always, at zero cost: the
   longest run of frozen quotes, how many quotes are crossed, how many prints are exact
   duplicates, how many prints arrived out of timestamp order, and the size of the largest
   single-print price jump.
3. **Triage** — each run's five bucketed diagnostics (never the raw feed or any recorded event)
   are sent to Jev with one `choice` question over six labels (five incident families plus
   "clean"). Jev returns a top guess and a probability for every label.
4. **Display** — runs are ranked with flagged (non-clean) guesses first, highest confidence first.
5. **Run diagnostic** — per card, this executes the one deterministic check that can actually
   confirm the guessed family: a run-length scan, a bounds check, a timestamp-order scan, or a
   recorded-event lookup. This is the only step that establishes a fact — including telling a real
   earnings move apart from an unadjusted split, which the bucketed statistics alone cannot do.
6. **Reveal ground truth** — shows the seeded incident per run and scores the triage (accuracy,
   missed incidents, false alarms — broken out by how many were genuine explained events — and
   Brier score).

## Fixtures

All data is synthetic — no real securities, no real feed.

Regenerate fixtures:

```sh
node fixtures/generate.mjs
```

The generator creates 45 runs: 6 each of 5 incident families (30), 10 plain clean runs, and 5
clean runs carrying a genuine, recorded price discontinuity as a deliberate hard negative for the
"unadjusted split" family. Each incident is injected with randomized severity, so the bucketed
diagnostics span the full none/mild/notable/severe range rather than always being an obvious tell.

## Methodology

This is a triage classification experiment, not a market-data monitor. Jev never sees the raw
feed or any recorded corporate-action/news event — only five bucketed summary statistics — and its
job is to prioritize which of a fixed set of deterministic checks is worth running, not to declare
a verdict on its own. The genuine-discontinuity hard negatives are there on purpose: a
magnitude-only heuristic cannot distinguish a real news move from an unadjusted split, and neither
can Jev from the bucketed statistics alone. Only the deterministic check, which looks up the
recorded event, resolves it. Ground truth is frozen and synthetic. Success is measured by triage
accuracy and calibration (Brier score) against seeded labels.

Jev's probabilities are model-output triage scores for a fixed six-class question, not guarantees
that a check will confirm.
