# Tape & Ladder

A tiny arcade take on browsing market data: instead of reading a chart, you walk it.

- **Terrain (left panel):** the price tape rendered as ground. Each candle body becomes a ledge
  you can stand on; the wick above it is a thin, non-solid spike. Run and jump across bars.
- **The Ladder (right panel):** the order book rendered as a climbing wall. Each level is a rung
  sized by quantity — climb past the spread and you've crossed from bid side to ask side.

Everything is synthetic, randomly generated fresh each run. No real market data, no account, no
trading — it's a feel-test for a control scheme, not a product.

## Controls

| Action | Key |
| --- | --- |
| Run left / right | `←` / `→` |
| Jump | `↑` |
| Climb the ladder up / down | `W` / `S` |
| New session (regenerate) | `R` |

Sound is on by default (synthesized in-browser via the Web Audio API — no audio files) and can be
muted with the toolbar toggle; the choice is remembered locally.

## Running it

It's a single self-contained `index.html` — open it directly in a browser, or serve the folder
with anything static (`npx serve .`, `python3 -m http.server`, etc).
