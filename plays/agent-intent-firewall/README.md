# Agent Intent Firewall

**Paper-trade drafts only — nothing here submits, executes, or connects to a broker.**

Type a plain-English futures order request. A general LLM drafts it into a structured order
(instrument, side, size, order type, stop-loss). Deterministic code computes tick value, exposure,
margin, and max loss against a small illustrative contract table. Jev judges whether the draft
matches what you asked, whether the request was ambiguous, and whether it should be reviewed. Code
— not Jev — makes the final call on what happens to the draft: ready, review required, or blocked.

This is the only Labs play that uses a general-purpose LLM as well as Jev, because it's the only
one that needs an "interpret and draft" step distinct from a "bounded judgment" step. The four
layers stay strictly separated: the LLM drafts, code computes and decides, Jev judges — matching
the responsibility split the whole `matchstick-labs`/Jev thesis is built on.

## Running it

Serve the folder with any static server:

```sh
python3 -m http.server 8771 --directory plays/agent-intent-firewall
```

Open `http://localhost:8771/`.

The page calls two `jev-regime-gate` endpoints: `/api/draft` (a general chat model drafts the
order) and `/api/judge-intent` (Jev judges the draft). There is no offline fallback — if either is
unavailable, the pipeline reports the failure, and an unavailable Jev judgment routes the draft to
review as a fail-safe rather than silently passing it.

## How it works

1. **Draft — LLM.** A general chat model (not Jev) reads your request and drafts a structured
   order. It never executes or submits anything; it only interprets. An incomplete or unclear
   request produces a draft with `null` fields rather than a guess.
2. **Compute — code, in your browser.** Fixed arithmetic against a small illustrative
   contract-spec table (tick value, point value, margin, reference price) computes exposure,
   margin, tick value, max loss, and what share of a fixed illustrative daily-loss limit that max
   loss would consume. View source for the exact table and formulas.
3. **Judge — Jev.** Jev never sees dollar figures — only your original text, the draft's
   restatement, and bucketed signals (stop-loss present or not, the daily-loss-impact bucket, the
   drafting model's own confidence). It answers three bounded questions: does the draft match your
   intent, is the request ambiguous, should a human review it.
4. **Decide — code, again.** Code owns the gate, not Jev:
   - A draft missing instrument, side, or quantity is **blocked** before Jev is ever asked.
   - A missing stop-loss, or a daily-loss impact bucketed `severe`, always forces **review**,
     regardless of what Jev says.
   - Beyond that, review is also triggered by a low Jev intent-match score or a high Jev
     ambiguity score.
   - Jev's own "needs review" score is shown but only forces the gate on its own when unusually
     high (>90%) — in testing it answers "yes" fairly liberally for almost any real order, so code
     treats it as one input among several rather than a single switch.
5. **Display.** Every outcome — ready, review required, or blocked — is labeled a paper-trade
   draft. There is no path to execution anywhere in this Lab.

## What's illustrative, not live

- **Contract specs** (tick size, tick value, point value, margin, reference price) for five
  instruments (ES, NQ, CL, GC, 6E) are fixed, approximate, and hardcoded in the page — not fetched
  from any live source, and not a substitute for a broker's actual specs or margin requirements.
- **The daily-loss limit** ($5,000) is a fixed illustrative constant, not a real account setting.
- **The drafting model** can misread a request. Its own `confidence` field is shown, and a
  low-confidence or incomplete draft is exactly the case this Lab is built to catch and flag.

## Methodology

This demonstrates a bounded review pipeline over a single-turn text request, not a market forecast,
a trading recommendation, or any form of broker integration. The three gate outcomes (ready,
review, blocked) are deterministic given the draft, the computed risk figures, and Jev's scores —
there is no hidden randomness in the gate logic itself, though the drafting model and Jev may both
vary slightly between identical-looking requests. Jev's probabilities are model-output judgment
scores for three fixed yes/no-as-probability questions, not guarantees.
