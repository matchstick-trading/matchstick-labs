# Decision Boundary Lab

Four bucketed regime features — volatility vs. baseline, trend persistence, ATR expansion, and
price vs. 50-day SMA — with no symbol attached. Change one dropdown at a time and watch Jev's
five-way regime distribution move, next to a fixed deterministic rule built from the same
plain-English criteria Jev is given. This is the feature space behind the Jev Regime Screener with
the symbol, the real returns, and the trade-compatibility gate stripped out.

Unlike the other three Labs plays, this is not a scored corpus with a "reveal ground truth" step —
there's no seeded label for an arbitrary feature combination. It's an evaluator/dev-mode tool for
watching how one input perturbation moves a probability distribution, not a benchmark.

## Running it

Serve the folder with any static server:

```sh
python3 -m http.server 8770 --directory plays/decision-boundary-lab
```

Open `http://localhost:8770/`.

The page calls the Jev boundary endpoint at `jev.matchstick.trading/api/boundary` on load and on
every dropdown change. There is no offline fallback — if Jev is unavailable, the deterministic
baseline panel still updates instantly, and the Jev panel reports the error.

## How it works

1. **Set four features** — each a dropdown over the same bucket vocabulary the live Jev Regime
   Screener computes from real bars, entered directly instead of derived from a symbol.
2. **Deterministic baseline** — a small fixed if/else rule, written to mirror the same
   plain-English criteria text Jev is given for each of its five regime labels (`trend_up`,
   `trend_down`, `range`, `chop`, `unclear`). It updates instantly, with no network call.
3. **Jev's distribution** — the same `regime_type` (5-way choice), `regime_change_likely`
   (yes/no-as-probability), and `strategy_viable` (yes/no-as-probability) questions the production
   Jev Regime Screener asks, sent with only the four features above as state.
4. **Change log** — every dropdown change is recorded with what changed and what both the baseline
   and Jev concluded, so a session of single-feature perturbations reads back as a short experiment
   log.

## What's removed, and why

The production Jev Regime Screener also takes a real ticker symbol, computes real 1-day and 5-day
returns, and runs a trade-compatibility gate that sizes a hypothetical position. All three are
removed here:

- **No symbol** — this Lab has no ticker lookup or real market data of any kind.
- **No returns** — the two numeric return features from the live product are dropped; only the
  four features least tied to a specific historical price move remain.
- **No trade gate** — the endpoint behind this Lab (`/api/boundary`) calls the same underlying
  classifier the live product uses, but never calls the position-sizing gate. There is no
  "compatible / not compatible" trading decision anywhere in this Lab.

## Methodology

This is a feature-space explainer, not a market-data monitor or a trading tool. Feature values are
arbitrary and not derived from any real security — you can select any combination, including ones
that would never occur together on a real instrument. The deterministic baseline is a hand-written
reference rule, not ground truth; when it and Jev disagree, that disagreement demonstrates where a
probabilistic judgment introduces nuance a fixed rule can't capture, not that either one is wrong.

Jev's probabilities are model-output classification scores for a fixed five-class question, not a
market forecast or a trading recommendation.
