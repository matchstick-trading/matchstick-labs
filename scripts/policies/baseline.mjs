// baseline.mjs — reference autoplay policy for scripts/autoplay-eval.mjs.
//
// Deliberately simple, not hand-tuned to squeeze out a high score: jump the
// nearest upcoming obstacle/hazard when it's within reaction range, hold the
// jump longer for the hazard types that need more airtime (gap, tunnel), and
// otherwise leave leverage untouched at whatever 1x-ish rung the run started
// on. This is a floor to measure against and a worked example of the policy
// contract — the actual difficulty-tuning work (this file included) is what
// the competing dev/player agents iterate on, not a finished bot.
//
// Reaction distance is a rough estimate from this game's jump physics
// (GRAVITY=1500, JUMP_V=-580 — see plays/tape-and-ladder/index.html), not a
// precise simulation of playerObstacleOverlap()'s hitbox math: trigger early
// enough that a tap jump's ~0.39s rise time has the player airborne well
// before arrival, at the closing speed reported live via `scrollSpeed`.
const REACT_TIME_S = 0.42;
const HELD_TYPES = new Set(["gap", "tunnel"]);
const TALL_HURDLE_PX = 50;

let lastJumpedAt = null; // worldX of the last obstacle/hazard this run already jumped for

function nearestAhead(state) {
  let best = null;
  for (const o of state.upcomingObstacles) {
    if (o.worldX <= state.playerX) continue;
    if (!best || o.worldX < best.worldX) best = { worldX: o.worldX, kind: "candle", hurdlePx: o.hurdlePx };
  }
  for (const h of state.upcomingHazards) {
    if (h.xStart <= state.playerX) continue;
    if (!best || h.xStart < best.worldX) best = { worldX: h.xStart, kind: h.type, hurdlePx: 0 };
  }
  return best;
}

export default {
  name: "baseline",
  async reset() {
    lastJumpedAt = null;
  },
  async tick(state, actions) {
    if (state.phase === "setup") {
      await actions.press(" ", 30); // confirm whatever starting leverage the run opened on
      return;
    }
    if (state.phase !== "running") return;

    const target = nearestAhead(state);
    if (!target) return;
    if (lastJumpedAt === target.worldX) return; // already handled this one

    const distance = target.worldX - state.playerX;
    const closingSpeed = Math.max(state.scrollSpeed, 1);
    const timeToArrival = distance / closingSpeed;
    if (timeToArrival > REACT_TIME_S) return;

    lastJumpedAt = target.worldX;
    const needsHold = HELD_TYPES.has(target.kind) || target.hurdlePx > TALL_HURDLE_PX;
    await actions.press("ArrowUp", needsHold ? 160 : 40);
  },
};
