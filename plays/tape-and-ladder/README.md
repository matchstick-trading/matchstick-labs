# Tape & Ladder

A small arcade game for people who read charts: the tape runs automatically, you jump marked
candles and manage leverage, and your highest P&L becomes your score.

Click **Start run** or press **Space**. Start at 1× while learning the rhythm. The course stays
hidden and stationary until you start. A new run resets the course and difficulty.

- **Chart:** synthetic OHLC candles, price scale, and current-price guide. Hollow green candles
  close higher; filled red candles close lower. Corresponding candles and runway objects share
  the same horizontal position.
- **Runway:** amber brackets mark candle obstacles. Jump those bodies; wicks are harmless.
  Small candles affect P&L as you pass, even in the air. The bottom histogram shows candle body
  magnitude (price movement), not traded volume.
- **Depth & leverage:** separate bid-size, price, and ask-size columns. The highlighted rung sets
  leverage from 1× to 8×. Above entry is long; below entry is short. Crossing entry changes side.
  This is an arcade control mapping, not an order-entry simulator.
- **Risk:** gains and losses are multiplied by leverage. Margin allows a drawdown of
  `18 / leverage` ticks from peak P&L; exceeding it ends the run. The meter and event labels show
  that allowance and actual leveraged changes.

Everything is generated locally from synthetic data. There is no real market data, account,
or trading. An optional score submission uses the existing leaderboard service.

## Controls

| Action | Key |
| --- | --- |
| Start | Start run, `Space`, or `Enter` |
| Jump; hold for greater height and distance | `Space` / `↑`, or press the chart |
| Move up / down the risk ladder | `W` / `S`, or ladder buttons |
| Pause / resume | `P` / `Escape`, or Pause / Resume |
| Help (pauses play) | `H`, or How to play |
| New run | `R`, or New run |

Touch devices have a large Jump / hold button and two ladder controls. Switching away from the
page pauses the game. Jump input just before landing is buffered for 110 ms. Keyboard-focused
buttons retain native Space/Enter activation.

Hold a jump to clear wider volume clusters and news gaps; stay low under hostile resistance.
Later hazards include support beams, Gann fans, and moving-average channels. The cue below the
chart names the next hazard and its action. Late channel reachability still needs a separate
physics tuning pass; longer bot survival does not establish human playability.

Sound is on by default (synthesized in-browser via the Web Audio API — no audio files) and can be
muted with the toolbar toggle; the choice is remembered locally.

## Running it

It's a single `index.html`, with optional Google Fonts. Serve the folder with any static server:

```sh
python3 -m http.server 8767 --directory plays/tape-and-ladder
```

Open `http://localhost:8767/`. Add `?seed=1` for a reproducible course; New run repeats that seed.
Without a seed, New run generates a new course.

From the repository root:

```sh
node scripts/ui-smoke.mjs
node scripts/autoplay-eval.mjs scripts/policies/fable-v1.mjs --seeds 1,2 --max-ms 45000
```

The interaction checks block external requests, including score writes. The autoplay policy
still contains some pre-M10 assumptions; treat it as a regression exercise, not a human benchmark.
See [the playtest report](../../docs/tape-and-ladder-playtest.md) for scope and evidence.
