# Find the Moment

Describe a market episode in plain language. Deterministic code searches and computes the
evidence. Jev ranks which shortlisted historical windows match. You verify against ground truth.
Nothing predicts or recommends a trade.

## Running it

Serve the folder with any static server:

```sh
python3 -m http.server 8767 --directory plays/find-the-moment
```

Open `http://localhost:8767/`.

The demo loads synthetic fixture data from `fixtures/corpus.json` and calls the Jev judge endpoint
at `jev.matchstick.trading/api/judge` for match ranking. If Jev is unavailable, it falls back to
deterministic heuristic ranking.

## How it works

1. **Choose a preset** — each describes a market episode type (failed breakout, trend exhaustion,
   gap continuation, false breakdown, volatility squeeze).
2. **Deterministic search** — code computes features over all 40 fixture windows and applies
   hard-rule filters to shortlist ≤12 candidates. No API calls.
3. **Jev ranking** — each candidate is sent to Jev with one `noul` question: "Does this window
   match the declared episode?" Jev returns a 0–1 match probability.
4. **Display** — candidates ranked by match score with mini price charts and bucketed features.
5. **Reveal ground truth** — shows the seeded episode labels and scores the ranking (recall@3,
   MRR, Brier score).

## Fixtures

All data is synthetic — no real securities, no market data licensing issues.

Regenerate fixtures:

```sh
node fixtures/generate.mjs
```

The generator creates 40 windows: 20 labeled episodes (4 each of 5 types) and 20 distractors.
Each window is 60 bars of synthetic OHLCV with pre-computed bucketed features.

## Methodology

This is a retrieval experiment, not a prediction tool. The model ranks historical episodes by
semantic similarity to a query. Ground truth is frozen and synthetic. Success is measured by
retrieval metrics (recall@3, MRR), not by whether any retrieved window later made money.

Jev scores are model-output match probabilities for the stated question, not calibrated odds of
any market outcome.
