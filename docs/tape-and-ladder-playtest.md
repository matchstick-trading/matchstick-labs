# Tape & Ladder: trader experience pass

Baseline: local main `75534b1`, including the Opus difficulty changes and Fable policy.
Review date: 2026-09-10. Browser playtesting and scripted checks are agent observations,
not evidence of customer preference or retention.

## Findings before implementation

- The help and touch controls advertise horizontal movement; the engine auto-runs.
- Setup has no visible Start button. Waiting during setup advances the hidden world,
  so time spent reading changes the opening. Restart retains the old terrain/hazards.
- A setup cursor can cross the spread without changing the actual position direction.
- Ambient bars and jump obstacles share a solid histogram silhouette. The actual
  price chart is tiny and vertically compressed. The player's square disappears among bars.
- Color names in the short-position instructions use the opposite text colors.
- Jump-hold behavior is absent from help, early landing inputs are discarded, and
  floating rewards show base amounts even at higher leverage.
- Risk is expressed as small numbers below the game; death copy offers no corrective action.
- The order book has centered bars, price/size collisions, and no column headings.

## Design and implementation plan

Make the chart the main visual object. The chart and runway share candle positions;
only marked obstacles occupy the runway. Preserve M10 hazard bounds, jump physics,
score formulas, and difficulty progression. Keep synthetic prices explicit.

Tokens: ink `#0b1220`, panel `#101c2d`, rule `#26374c`, bid `#43d9ad`,
ask `#fa7785`, warning `#f2bb66`. IBM Plex Sans for instructions and titles;
IBM Plex Mono for prices, quantities, keys, and scores. Left-aligned terminal layout.

```text
Tape & Ladder                                  Pause / Help / Sound
Peak P&L     Live P&L     Position     Margin remaining
+-------------------------------------+------------------+
| Synthetic OHLC chart + price scale   | Bid / Price / Ask|
|                                     | Selected risk    |
| Candle runway + next-hazard cue      | W / S controls   |
| Price movement strip                | Margin meter     |
+-------------------------------------+------------------+
Jump / hold instruction                 Start / resume
```

Brief check: the memorable element is the playable chart. No CRT flicker, decorative
glow, marketing cards, or unrelated illustrations. Candle color always means price
direction; outlines and symbols identify gameplay risk independently of that color.
The reference chart displays OHLC levels; the runway encodes jump height and is
labeled accordingly. The lower strip is labeled price movement, since no volume
data exists in the generator.

Implementation targets in the baseline `plays/tape-and-ladder/index.html`:
1. Styles and markup (1–346): terminal layout, setup/start, honest control legend,
   accessible dialogs, mobile controls, risk and event feedback.
2. Drawing and HUD (1972–2602): readable OHLC scale, candle obstacles, bid/ask
   columns, explicit risk/price meanings, margin meter, hazard instructions.
3. Setup/reset/input/loop (619–629, 1604–1613, 2433–2510, 2692–2827): consistent
   setup direction, fresh runs, pause behavior, buffered landing input.
4. Feedback (1766–1803, 2652–2664): actual leveraged changes and actionable death
   explanation. Update the README and verify desktop, narrow screens, and keyboard.

## Implemented

- Replaced the CRT presentation with a compact terminal: readable OHLC candles and
  price axis, a shared chart/runway cursor, hollow up candles, filled down candles,
  and aligned bid/price/ask depth. Canvas backing resolution follows rendered size.
- Marked full candle collision bounds with amber brackets, linked them to the
  reference candles, and removed misleading ambient runway columns. Gaps render
  before ordinary candles so their collision bodies cannot be painted over.
- Added a visible Start button, concise control instructions, next-hazard cues,
  actual leveraged event labels, a margin meter, and an actionable death explanation.
- Fixed setup direction, frozen setup, fresh-course reset, stale game-over timers,
  110ms jump buffering, Space jumping, pause/resume, blur input release, and help
  input/focus handling. Hazard processing now stops as soon as the run ends.
- Added scrollable dialogs, compact mobile layout, usable touch controls, restrained
  reduced-motion feedback, and current README instructions.

The M10 jump impulse, gravity, hold extension, collision bounds, hazard sizes,
scroll speeds, unlock schedule, and scoring formula were retained. Input buffering
and the corrected setup/reset lifecycle intentionally change behavior. No online
leaderboard entry or deployment was made.

## Verification

`node scripts/ui-smoke.mjs`: **9/9 passed**, with external requests blocked.
The checks cover stationary setup, both starting directions, fresh reset, Space jump,
near-landing buffering and expiration, pause/resume, blur releasing held input,
and help input suppression/focus/keyboard closing.

Browser checks used desktop 1280×800 and touch-enabled 390×844 / 320×844 layouts.
Start, touch jump, ladder movement, and a scrollable help close action worked;
there was no horizontal overflow or uncaught script error. The desktop chart and
next-action cue fit within the viewport. A separate 8× run confirmed an actual
−8-tick event label and that restarting during the game-over delay does not reopen
the old result dialog. Inline scripts compile and `git diff --check` passes.

Existing Fable policy, seeds 1 and 2, 40ms decision polling, 45-second cap:

| Run | Peak P&L | Distance | Result |
| --- | ---: | ---: | --- |
| Seed 1 | 67 | 8,876 px | Alive at timeout |
| Seed 2 | 61 | 8,893 px | Alive at timeout |

Before this pass, the same two bounded Fable runs also survived their timeouts
(scores 62 and 87). These are regression observations, not evidence of improved
survival or a statistically meaningful difficulty comparison. Setup timing was
previously part of course generation; this pass deliberately removes that variance.

## Remaining design questions

- The player still jumps in a separate runway. Making floating price bodies the
  actual platforms requires a new physics model and a separate difficulty pass.
- MA channel paths are not constrained to a reachable jump arc. M10 reduced their
  cost; it did not demonstrate that every generated channel can be cleared. That
  source finding was not isolated in a runtime reproduction here.
- Hazard combinations still need longer playtesting. Making candles visible in
  gaps fixes misleading rendering, not every possible overlap or timing conflict.
- Fable still mirrors older spike spacing/height and fan-width constants. Its
  success is an automated strategy, not a calibrated expert-human benchmark.
- Trader preference, first-run comprehension, and repeat-play motivation have not
  been measured. The next product check is observing traders start and play this
  version without coaching, before changing the engine again.
