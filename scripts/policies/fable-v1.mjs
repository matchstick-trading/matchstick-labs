// fable-v1.mjs — "player" autoplay policy for scripts/autoplay-eval.mjs.
//
// Strategy (what this does differently from baseline.mjs, and why):
//
// 1. Physics-exact jump planning instead of a fixed reaction window. The game's
//    jump is a deterministic ~60Hz semi-implicit Euler arc (GRAVITY/JUMP_V/
//    JUMP_HOLD_* in plays/tape-and-ladder/index.html), and every hurdle the
//    state exposes has a knowable hitbox window (candles: player-x in
//    (worldX-1, worldX+25) at feet-height hurdlePx-6; volSpikes: 3-4 thin bars at
//    44px spacing reconstructed from xStart/xEnd; gaps: a pit you must carry
//    across with a held jump; walls: a ceiling you must NOT hold a jump under).
//    Each tick this simulates candidate takeoff points against all of that —
//    including walking on the ground up to the takeoff — picks the one with the
//    best clearance margin and safest landing runway, and schedules the keypress
//    for the exact moment inside the tick (setTimeout) rather than at the 40ms
//    poll boundary. Baseline wastes presses while airborne (a press that lands
//    mid-flight is silently consumed and the obstacle is never retried) and can't
//    handle clusters; this plans chained jumps and re-presses at landing.
//
// 2. Direction is a hazard tool, not decoration. Walls are only avoidable in
//    LONG (resistance is a ceiling above a tap jump's apex; support is harmless);
//    Gann fans are only free in SHORT (the hostile lines are the rising ones,
//    which never come down to ground level — but they all converge at the pivot,
//    so no jumping right after the pivot). So: LONG by default, flip to SHORT
//    before each fan's collidable core (while it's still outside the game's
//    reclassify lockout window), flip back after. 1x LONG <-> 1x SHORT is one
//    ladder keypress with no leverage change.
//
// 3. Leverage is pumped only around verified wins. Every PnL delta is scaled by
//    the leverage at the instant it resolves, and an obstacle clear (+2) resolves
//    at a known x (worldX+30) while the only random-sign events nearby (sampled
//    ambient bars, every 3rd column) resolve at other known x's. So once a jump's
//    arc is confirmed to clear, raise to 2x (or 3x when both neighbouring sampled
//    bars are 3 columns away) just before the clear registers and drop back to 1x
//    right after — before the next ambient bar can land at high leverage. Never
//    pumps near a hazard or with meaningful drawdown. Cushion is BASE_CUSHION/L,
//    so sustained leverage is a coin-flip death; timed leverage is not.
//
// 4. Tunnels are handled adaptively. The tunnel's band position isn't in the
//    state, but grazes are visible as -1 PnL ticks, so inside a tunnel the policy
//    measures graze rate on the ground vs. during tap/held hops and keeps
//    whichever mode grazes least.
//
// Everything goes through the real keyboard path (actions.keyDown/keyUp). The
// policy only reads what getState() exposes; no internal state is touched.

import { appendFileSync } from "node:fs";

// ---- game constants (mirrors plays/tape-and-ladder/index.html; see there) ----
const DT = 1 / 60;                // arc integration step used by the sim
const FRAME_MS = 16.4;            // measured headless rAF period (61Hz) for time predictions
const GRAVITY = 1500, JUMP_U = 580, HOLD_GRAVITY = 1500 * 0.45, HOLD_MAX_FRAMES = 12;
const COLW = 24;
const PLAYER_HALF_W = 6;          // PLAYER_W/2 (body, used by gap ground test)
const PLAYER_H = 18;
const HIT_INSET_TOP = 6;
const CANDLE_WIN_LO = -1, CANDLE_WIN_HI = 25; // player-center x range overlapping a column's inset hitbox
const VOLSPIKE_SPACING = 44, VOLSPIKE_WIDTH = 10, VOLSPIKE_MAX_H = 50;
const SPIKE_WIN_LO = -1, SPIKE_WIN_HI = 11;
const GAP_FALL_DEPTH = 20;
const GANN_CORE = 420, GANN_FADE = 140;
const GANN_MIN_PIVOT_H = 60;      // pivotY = baseline - (60 + rand*120)
const GANN_HIT_THICK = 6;
const WALL_CEIL_FEET_MAX = 128;   // min resistance clearance 140 - 12 (see testWallCollision)
const LOCKOUT_AHEAD_PX = 3 * COLW;
const LADDER_COOLDOWN_MS = 120;
const LONG_1X_IDX = 8, SHORT_1X_IDX = 7;

// ---- policy tuning ----
const KEY_LATENCY_MS = 2;         // keyboard.down -> page keydown (measured ~1-6ms)
const STATE_AGE_MS = 3;           // getState round trip (measured ~3ms)
const HORIZON_MS = 48;            // press scheduled if due within this much (poll is 40ms)
const CLEAR_MARGIN = 5;           // px of feet clearance required above hurdle top
const MARGIN_CAP = 15;
const COMFORTABLE_S = 0.42;       // runway (in seconds of travel) after landing before next hurdle
const FLIP_HURDLE_GUARD_PX = 110; // don't flip direction with a hurdle closer than this
const PUMP_MIN_ARC_MARGIN = 8;
const PUMP_EVENT_PAD_MS = 24;     // frame quantization + jitter pad around resolve points
const PUMP_MOVE_GAP_MS = 128;     // > LADDER_COOLDOWN_MS
const PUMP_MAX_DRAWDOWN_2X = 4, PUMP_MAX_DRAWDOWN_3X = 2;
const PUMP_HAZARD_EXCLUDE_PX = 60;
const TUNNEL_GROUND_PROBE_MS = 450;

// ---- module state (reset per seed) ----
let S = null;
function freshState() {
  return {
    started: false,
    groundY: null,
    tState: 0, x: 0, v: 130, tPrevTick: 0, xPrevTick: 0,
    lastPnl: 0, lastLev: 1,
    wantLong: true,
    pumpLevel: 0,
    pumpActive: false,
    expectedIdx: null,
    lastLadderPressAt: -Infinity,
    jump: null,           // { tDown, hold, xA (refined), holdEff, plan }
    pumped: new Set(),
    timers: [],
    busy: false,
    log: process.env.FABLE_LOG ? process.env.FABLE_LOG : null,
    tun: null,            // tunnel-mode bookkeeping
  };
}

function now() { return performance.now(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }
function logEvent(obj) {
  if (!S || !S.log) return;
  try { appendFileSync(S.log, JSON.stringify({ t: Math.round(now()), ...obj }) + "\n"); } catch {}
}

// ---- arc tables ----
const arcCache = new Map();
function arcTable(holdFrames) {
  if (arcCache.has(holdFrames)) return arcCache.get(holdFrames);
  const h = [0], u = [JUMP_U];
  let hh = 0, uu = JUMP_U, holdLeft = holdFrames;
  for (let k = 1; k < 140; k++) {
    let g = GRAVITY;
    if (holdLeft > 0 && uu > 0) { g = HOLD_GRAVITY; holdLeft--; }
    uu -= g * DT;
    hh += uu * DT;
    h.push(hh); u.push(uu);
    if (hh < -80) break;
  }
  const t = { h, u };
  arcCache.set(holdFrames, t);
  return t;
}

// ---- world model from state ----
function buildWorld(state, xNow) {
  const hurdles = [], pits = [], ceilings = [], hazards = [], fans = [];
  for (const o of state.upcomingObstacles) {
    if (o.worldX + CANDLE_WIN_HI < xNow - 5) continue;
    hurdles.push({ a: o.worldX + CANDLE_WIN_LO, b: o.worldX + CANDLE_WIN_HI, r: o.hurdlePx - HIT_INSET_TOP, kind: "candle", id: "c" + Math.round(o.worldX), col: Math.round(o.worldX / COLW) });
  }
  for (const hz of state.upcomingHazards) {
    if (hz.type === "volSpikes") {
      const n = Math.max(1, Math.round((hz.xEnd - VOLSPIKE_WIDTH - hz.xStart) / VOLSPIKE_SPACING) + 1);
      for (let k = 0; k < n; k++) {
        const sx = hz.xStart + k * VOLSPIKE_SPACING;
        if (sx + SPIKE_WIN_HI < xNow - 5) continue;
        hurdles.push({ a: sx + SPIKE_WIN_LO, b: sx + SPIKE_WIN_HI, r: VOLSPIKE_MAX_H - HIT_INSET_TOP, kind: "spike", id: "v" + Math.round(hz.xStart) + "_" + k });
      }
      hazards.push({ type: hz.type, s: hz.xStart, e: hz.xEnd });
    } else if (hz.type === "gap") {
      pits.push({ s: hz.xStart, e: hz.xEnd });
      hazards.push({ type: hz.type, s: hz.xStart, e: hz.xEnd });
    } else if (hz.type === "wall") {
      ceilings.push({ s: hz.xStart, e: hz.xEnd, hmax: WALL_CEIL_FEET_MAX });
      hazards.push({ type: hz.type, s: hz.xStart, e: hz.xEnd });
    } else if (hz.type === "gannFan") {
      const pivotX = hz.xEnd - GANN_CORE - GANN_FADE;
      hazards.push({ type: hz.type, s: pivotX, e: pivotX + GANN_CORE, pivotX });
      fans.push({ pivotX, e: pivotX + GANN_CORE });
    } else if (hz.type === "tunnel") {
      hazards.push({ type: hz.type, s: hz.xStart, e: hz.xEnd });
    }
  }
  hurdles.sort((p, q) => p.a - q.a);
  return { hurdles, pits, ceilings, hazards, fans, shortFans: !S.wantLong || (state.direction === "SHORT") };
}

function overPit(world, x) {
  for (const p of world.pits) if (x + PLAYER_HALF_W > p.s && x - PLAYER_HALF_W < p.e) return true;
  return false;
}

// In SHORT the hostile fan lines rise from the pivot at slopes 1/2/4 (per px of
// x). Pivot height above baseline is unknown in [60,180]; the lowest possible
// hostile line at dx is 60+dx. Player centre is feet+9; hit if within 6px.
function fanViolation(world, x, h) {
  if (!world.shortFans) return false;
  for (const f of world.fans) {
    const dx = x - f.pivotX;
    if (dx < 0 || dx > GANN_CORE) continue;
    if (h + PLAYER_H / 2 + GANN_HIT_THICK + 3 > GANN_MIN_PIVOT_H + dx) return true;
  }
  return false;
}

// Simulate walking from xNow to xA on the ground, then a jump taking off at xA.
function evalJump(xNow, xA, v, hold, world) {
  const arc = arcTable(hold);
  const hitIds = new Set();
  let minMargin = Infinity, land = null, fell = false, cleared = new Set();
  // Ground walk [xNow, xA]: any hurdle window overlapping it is a hit; a pit is a fall.
  for (const hd of world.hurdles) if (hd.r > 0 && hd.b > xNow && hd.a < xA) hitIds.add(hd.id);
  for (const p of world.pits) if (p.e > xNow && p.s - PLAYER_HALF_W < xA) hitIds.add("pit" + Math.round(p.s));
  if (overPit(world, xA)) return { hits: 99, fell: true, minMargin: -99, land: xA, cleared, hitIds };
  for (let k = 1; k < arc.h.length; k++) {
    const x = xA + v * k * DT, h = arc.h[k], u = arc.u[k];
    if (overPit(world, x)) {
      if (h <= -GAP_FALL_DEPTH + 2) { fell = true; land = x; break; }
    } else if (h <= 0 && u <= 0) {
      land = x;
      for (const hd of world.hurdles) if (x > hd.a && x < hd.b && hd.r > 0) hitIds.add(hd.id);
      break;
    }
    for (const hd of world.hurdles) {
      if (x > hd.a && x < hd.b) {
        const m = h - hd.r;
        if (m < CLEAR_MARGIN) hitIds.add(hd.id); else cleared.add(hd.id);
        if (m < minMargin) minMargin = m;
      }
    }
    for (const c of world.ceilings) {
      if (x >= c.s - 2 && x <= c.e + 2 && h > c.hmax - 4) hitIds.add("ceil");
    }
    if (fanViolation(world, x, h)) { hitIds.add("fan"); hitIds.add("fan2"); }
  }
  if (land == null) { land = xA + v * (arc.h.length - 1) * DT; }
  for (const id of hitIds) cleared.delete(id);
  return { hits: hitIds.size + (fell ? 1 : 0), fell, minMargin, land, cleared, hitIds };
}

function nextHurdleAfter(world, x) {
  for (const hd of world.hurdles) if (hd.a > x) return hd;
  return null;
}
function firstThingAhead(world, x) {
  let best = null;
  const hd = nextHurdleAfter(world, x);
  if (hd) best = { a: hd.a, kind: hd.kind };
  for (const p of world.pits) if (p.e > x && (!best || p.s - PLAYER_HALF_W < best.a)) best = { a: p.s - PLAYER_HALF_W, kind: "pit" };
  return best;
}

// Full candidate evaluation with a depth-2 lookahead for the landing runway.
function evalCandidate(xNow, xA, v, hold, world, requireUseful) {
  const r = evalJump(xNow, xA, v, hold, world);
  const first = firstThingAhead(world, xNow);
  let useful = !requireUseful;
  if (first) {
    if (first.kind === "pit") useful = useful || r.land > first.a + 2 * PLAYER_HALF_W || r.fell;
    else useful = useful || r.land > first.a;
  }
  let runway = Infinity, rejump = null, chainHits = 0;
  const nxt = nextHurdleAfter(world, r.land);
  if (nxt) {
    runway = nxt.a - r.land;
    if (runway < v * COMFORTABLE_S) {
      // Must re-jump right at landing: verify a chained jump from 1..3 frames after landing.
      let bestChain = null;
      for (const h2 of [0, 9]) {
        let worst = 0, worstMargin = Infinity;
        for (const kk of [1, 3]) {
          const r2 = evalJump(r.land, r.land + v * kk * DT, v, h2, world);
          worst = Math.max(worst, r2.hits);
          worstMargin = Math.min(worstMargin, r2.minMargin);
        }
        if (!bestChain || worst < bestChain.hits || (worst === bestChain.hits && worstMargin > bestChain.margin)) bestChain = { hold: h2, hits: worst, margin: worstMargin };
      }
      rejump = bestChain;
      chainHits = bestChain.hits;
    }
  }
  return { xA, hold, hits: r.hits, chainHits, fell: r.fell, minMargin: r.minMargin, land: r.land, runway, useful, rejump, cleared: r.cleared };
}

function scoreCandidate(c, xNow) {
  if (!c.useful) return Infinity;
  const margin = Math.min(c.minMargin === Infinity ? MARGIN_CAP : c.minMargin, MARGIN_CAP);
  const runway = Math.min(c.runway === Infinity ? 200 : c.runway, 120);
  return (c.hits + c.chainHits) * 1000 - margin * 10 - runway * 0.15 + (c.hold > 0 ? 6 : 0) + (c.rejump ? 4 : 0) + (c.xA - xNow) * 0.02;
}

// ---- ladder control ----
function desiredIdx() {
  return S.wantLong ? LONG_1X_IDX + S.pumpLevel : SHORT_1X_IDX - S.pumpLevel;
}
async function ladderStep(actions, dir) {
  S.lastLadderPressAt = now();
  await actions.keyDown(dir > 0 ? "w" : "s");
  await actions.keyUp(dir > 0 ? "w" : "s");
}
async function ladderController(state, actions) {
  if (S.pumpActive) return; // timed presses own the ladder during a pump
  S.expectedIdx = state.ladderIdx;
  const want = desiredIdx();
  if (state.ladderIdx === want) return;
  if (now() - S.lastLadderPressAt < LADDER_COOLDOWN_MS + 8) return;
  await ladderStep(actions, want > state.ladderIdx ? 1 : -1);
  S.expectedIdx = state.ladderIdx + (want > state.ladderIdx ? 1 : -1);
  logEvent({ ev: "ladder", from: state.ladderIdx, want, x: Math.round(S.x) });
}

// ---- direction management ----
function updateWantLong(state, world, xNow) {
  let wantLong = true;
  for (const hz of world.hazards) {
    if (hz.type !== "gannFan") continue;
    const ahead = hz.pivotX - xNow;
    if (xNow < hz.e + 10 && ahead < 260) { wantLong = false; break; }
  }
  if (wantLong === S.wantLong) return;
  // Only flip when it's safe: flipping reclassifies bars beyond the lockout,
  // which can conjure a new obstacle >72px ahead.
  const first = firstThingAhead(world, xNow);
  const clear = !first || first.a - xNow > FLIP_HURDLE_GUARD_PX;
  const urgent = !wantLong && world.hazards.some((hz) => hz.type === "gannFan" && hz.pivotX - xNow < LOCKOUT_AHEAD_PX + 30 && hz.pivotX - xNow > 0);
  if (state.onGround && (clear || urgent) && !S.pumpActive) {
    S.wantLong = wantLong;
    logEvent({ ev: "wantLong", wantLong, x: Math.round(xNow) });
  }
}

// ---- time/x model ----
function xAt(t) { return S.x + S.v * (t - S.tState) / 1000; }
function tAtX(x) { return S.tState + (x - S.x) / S.v * 1000; }

// ---- jump execution ----
async function pressJump(actions, holdFrames) {
  const tDown = now();
  await actions.keyDown("ArrowUp");
  if (holdFrames > 0) {
    await sleep(holdFrames * FRAME_MS + 14);
  }
  await actions.keyUp("ArrowUp");
  return tDown;
}

async function spamRejump(actions, tFrom, tTo, holdAfter) {
  await sleep(tFrom - now());
  while (now() < tTo) {
    await actions.keyDown("ArrowUp");
    await actions.keyUp("ArrowUp");
    await sleep(2);
  }
  if (holdAfter > 0) {
    await actions.keyDown("ArrowUp");
    await sleep(holdAfter * FRAME_MS);
    await actions.keyUp("ArrowUp");
  }
}

function refineTakeoff(state, h) {
  // First airborne observation after our press: match observed height to the arc.
  const j = S.jump;
  if (!j || j.xA != null) return;
  const tObs = S.tState;
  let best = null;
  for (const hold of j.hold > 0 ? [j.hold, j.hold - 1] : [0, 1]) {
    const arc = arcTable(Math.max(0, hold));
    for (let k = 1; k < arc.h.length; k++) {
      if (arc.u[k] < 0 && arc.h[k] < h - 40) break;
      const d = Math.abs(arc.h[k] - h);
      if (!best || d < best.d) best = { d, k, hold: Math.max(0, hold) };
    }
  }
  if (!best) return;
  j.xA = state.playerX - S.v * best.k * DT;
  j.holdEff = best.hold;
  j.tTakeoff = tObs - best.k * FRAME_MS;
}

// ---- leverage pump ----
function schedule(fn, at) {
  const id = setTimeout(fn, Math.max(0, at - now()));
  S.timers.push(id);
}
function planPump(state, world, actions, xNow) {
  const j = S.jump;
  if (!j || j.xA == null || S.pumpActive) return;
  const drawdown = state.hwmTicks - state.pnlTicks;
  if (drawdown > PUMP_MAX_DRAWDOWN_2X) return;
  if (state.ladderIdx !== desiredIdx() || S.pumpLevel !== 0) return;
  const arc = arcTable(j.holdEff);
  // target: first candle in this flight not yet resolved and not yet pumped
  for (const hd of world.hurdles) {
    if (hd.kind !== "candle") continue;
    if (S.pumped.has(hd.id)) continue;
    const xClear = hd.col * COLW + COLW + PLAYER_HALF_W; // resolve point: x-6 > (col+1)*24
    if (xClear <= xNow + 2) continue;
    // Verify the arc over this hurdle from the refined takeoff.
    let ok = true, landed = false;
    for (let k = 1; k < arc.h.length; k++) {
      const x = j.xA + S.v * k * DT, h = arc.h[k];
      if (h <= 0 && arc.u[k] <= 0) { landed = x > hd.b; break; }
      if (x > hd.a && x < hd.b && h - hd.r < PUMP_MIN_ARC_MARGIN) { ok = false; break; }
    }
    if (!ok || !landed) return;
    // No hazard anywhere near the pump window.
    const winLo = xNow - PUMP_HAZARD_EXCLUDE_PX, winHi = xClear + 4 * COLW + PUMP_HAZARD_EXCLUDE_PX;
    for (const hz of world.hazards) if (hz.e + 20 > winLo && hz.s - 20 < winHi) return;
    // sampled neighbours (col % 3 === 0), excluding this column
    const col = hd.col;
    let jPrev = col - 1; while (jPrev % 3 !== 0) jPrev--;
    let jNext = col + 1; while (jNext % 3 !== 0) jNext++;
    const tClear = tAtX(xClear);
    const tPrev = tAtX(jPrev * COLW + COLW + PLAYER_HALF_W);
    const tNext = tAtX(jNext * COLW + COLW + PLAYER_HALF_W);
    const tNow = now();
    const earliest = Math.max(tPrev + PUMP_EVENT_PAD_MS, tNow + 2, S.lastLadderPressAt + LADDER_COOLDOWN_MS + 8);
    const deadline = tNext - PUMP_EVENT_PAD_MS;
    const dir = S.wantLong ? 1 : -1;
    // try 3x: two raises before clear, two lowers after
    let plan = null;
    if (drawdown <= PUMP_MAX_DRAWDOWN_3X) {
      const r1 = Math.max(earliest, tClear - 2 * PUMP_MOVE_GAP_MS - 60);
      const r2 = r1 + PUMP_MOVE_GAP_MS;
      const l1 = Math.max(r2 + PUMP_MOVE_GAP_MS, tClear + FRAME_MS + PUMP_EVENT_PAD_MS);
      const l2 = l1 + PUMP_MOVE_GAP_MS;
      if (r2 <= tClear - 6 && l2 <= deadline) plan = { level: 2, moves: [[r1, dir], [r2, dir], [l1, -dir], [l2, -dir]] };
    }
    if (!plan) {
      const r1 = Math.max(earliest, tClear - 70);
      const l1 = Math.max(r1 + PUMP_MOVE_GAP_MS, tClear + FRAME_MS + PUMP_EVENT_PAD_MS);
      if (r1 <= tClear - 6 && l1 <= deadline) plan = { level: 1, moves: [[r1, dir], [l1, -dir]] };
    }
    if (!plan) return;
    S.pumped.add(hd.id);
    S.pumpActive = true;
    const baseIdx = state.ladderIdx;
    S.expectedIdx = baseIdx;
    logEvent({ ev: "pump", id: hd.id, level: plan.level, x: Math.round(xNow), xClear: Math.round(xClear), tClearIn: Math.round(tClear - tNow), dPrev: Math.round(xClear - (jPrev * COLW + COLW + PLAYER_HALF_W)), dNext: Math.round((jNext * COLW + COLW + PLAYER_HALF_W) - xClear), moves: plan.moves.map(([at, d]) => [Math.round(at - tNow), d]) });
    for (const [at, d] of plan.moves) {
      schedule(async () => {
        if (d !== dir && S.expectedIdx === baseIdx) return; // nothing to undo (raise was dropped)
        S.lastLadderPressAt = now();
        S.expectedIdx += d;
        S.pumpLevel += d === dir ? 1 : -1;
        try { await actions.keyDown(d > 0 ? "w" : "s"); await actions.keyUp(d > 0 ? "w" : "s"); } catch {}
      }, at);
    }
    // Whatever happened, hand the ladder back to the controller (wanting 1x) by
    // the deadline; it re-syncs from the live state and fixes any residue.
    schedule(() => { S.pumpActive = false; S.pumpLevel = 0; }, deadline + 5);
    return;
  }
}

// ---- tunnel mode ----
function tunnelAt(world, x) {
  for (const hz of world.hazards) if (hz.type === "tunnel" && x >= hz.s - 4 && x <= hz.e) return hz;
  return null;
}
function tunnelUpdate(state, world, dPnl, dtMs) {
  const tz = tunnelAt(world, S.x);
  if (!tz) { if (S.tun) logEvent({ ev: "tunnel-exit", grazes: S.tun.total, modes: S.tun.modes }); S.tun = null; return null; }
  if (!S.tun || S.tun.id !== tz.s) {
    S.tun = { id: tz.s, total: 0, modes: { ground: { g: 0, ms: 0 }, tap: { g: 0, ms: 0 }, hold: { g: 0, ms: 0 } }, flight: null };
  }
  const t = S.tun;
  const grazes = dPnl < 0 && dPnl > -3 * state.leverage ? Math.round(-dPnl / state.leverage) : 0;
  t.total += grazes;
  const mode = !state.onGround && t.flight ? t.flight : "ground";
  t.modes[mode].g += grazes;
  t.modes[mode].ms += dtMs;
  if (state.onGround && t.flight && S.jump == null) t.flight = null;
  return t;
}
function tunnelChooseMode(t) {
  const rate = (m) => (m.ms > 0 ? m.g / (m.ms / 1000) : null);
  const g = t.modes.ground, tap = t.modes.tap, hold = t.modes.hold;
  if (g.ms < TUNNEL_GROUND_PROBE_MS && tap.ms === 0 && hold.ms === 0) return "ground";
  const gr = rate(g);
  if (gr !== null && gr < 2.2 && tap.ms === 0) return "ground"; // ground is (mostly) inside the band
  if (tap.ms === 0) return "tap";
  if (hold.ms === 0) return "hold";
  const cands = [["ground", gr ?? 99], ["tap", rate(tap)], ["hold", rate(hold)]];
  cands.sort((a, b) => a[1] - b[1]);
  return cands[0][0];
}

// ---- main ----
async function onTick(state, actions) {
  const tNow = now();
  const dtMs = S.tPrevTick ? tNow - S.tPrevTick : 40;
  S.tPrevTick = tNow;
  S.tState = tNow - STATE_AGE_MS;
  S.x = state.playerX;
  S.v = Math.max(1, state.scrollSpeed);
  if (state.onGround && S.groundY == null) S.groundY = state.playerY;
  const h = S.groundY != null ? S.groundY - state.playerY : 0;

  const world = buildWorld(state, S.x);
  // PnL event logging
  const dPnl = state.pnlTicks - S.lastPnl;
  if (dPnl !== 0) {
    const near = world.hazards.filter((hz) => hz.e > S.x - 80 && hz.s < S.x + 80).map((hz) => hz.type + "@" + Math.round(hz.s - S.x));
    const first = firstThingAhead(world, S.x);
    logEvent({ ev: "pnl", d: dPnl, pnl: state.pnlTicks, hwm: state.hwmTicks, lev: state.leverage, x: Math.round(S.x), g: state.onGround, h: Math.round(h), dir: state.direction, near, next: first ? first.kind + "@" + Math.round(first.a - S.x) : null, jump: S.jump ? { xA: S.jump.xA && Math.round(S.jump.xA), hold: S.jump.hold } : null });
    S.lastPnl = state.pnlTicks;
  }
  if (state.leverage !== S.lastLev) { logEvent({ ev: "lev", lev: state.leverage, idx: state.ladderIdx, x: Math.round(S.x), pump: S.pumpLevel }); S.lastLev = state.leverage; }

  if (!state.onGround && S.jump) refineTakeoff(state, h);
  if (state.onGround && S.jump && tNow - S.jump.tDown > 150) S.jump = null;
  const tun = tunnelUpdate(state, world, dPnl, dtMs);

  updateWantLong(state, world, S.x);
  await ladderController(state, actions);

  if (!state.onGround) {
    planPump(state, world, actions, S.x);
    return;
  }
  if (S.jump && tNow - S.jump.tDown < 150) return; // press in flight, waiting for takeoff to show

  // ---- plan a jump ----
  const first = firstThingAhead(world, S.x);
  let pressed = false;
  if (first && first.a - S.x <= S.v * 0.75) {
    const xMin = Math.ceil(S.x + 1), xMax = S.x + S.v * 0.7;
    const holds = world.pits.some((p) => p.s - S.x < 300 && p.e > S.x) ? [HOLD_MAX_FRAMES, 0] : [0, HOLD_MAX_FRAMES, 6];
    const results = new Map();
    let best = null;
    for (const hold of holds) {
      for (let xA = xMin; xA <= xMax; xA += 2) {
        const c = evalCandidate(S.x, xA, S.v, hold, world, true);
        const sc = scoreCandidate(c, S.x);
        results.set(hold + ":" + xA, { c, sc });
        if (sc !== Infinity && (!best || sc < best.sc)) best = { c, sc };
      }
    }
    if (process.env.FABLE_DEBUG) logEvent({ ev: "plan", x: Math.round(S.x), first: first.kind + "@" + Math.round(first.a - S.x), best: best ? { xA: best.c.xA, hold: best.c.hold, hits: best.c.hits, chain: best.c.chainHits, margin: +best.c.minMargin.toFixed(1), land: Math.round(best.c.land), runway: Math.round(best.c.runway), sc: +best.sc.toFixed(1) } : null });
    if (best) {
      // Contiguous acceptable interval around best (same hold, same hit count).
      const key = (xA) => best.c.hold + ":" + xA;
      const okAt = (xA) => { const r = results.get(key(xA)); return r && r.sc !== Infinity && (r.c.hits + r.c.chainHits) === (best.c.hits + best.c.chainHits); };
      let lo = best.c.xA, hi = best.c.xA;
      while (okAt(lo - 2)) lo -= 2;
      while (okAt(hi + 2)) hi += 2;
      const frameSpan = S.v * DT;
      const latPx = S.v * KEY_LATENCY_MS / 1000;
      let xPressTarget = best.c.xA - frameSpan / 2;
      xPressTarget = Math.max(lo, Math.min(hi - frameSpan, xPressTarget));
      if (hi - lo < frameSpan) xPressTarget = lo; // narrow window: best effort
      const tPress = tAtX(xPressTarget - latPx);
      const tooLate = xAt(tNow) + latPx > hi;
      if (tPress - tNow <= HORIZON_MS && !tooLate) {
        await sleep(tPress - now());
        const tDown = await pressJump(actions, best.c.hold);
        S.jump = { tDown, hold: best.c.hold, xA: null, holdEff: best.c.hold, plan: best.c };
        if (tun) tun.flight = best.c.hold > 0 ? "hold" : "tap";
        pressed = true;
        logEvent({ ev: "jump", hold: best.c.hold, xA: best.c.xA, lo, hi, x: Math.round(S.x), v: Math.round(S.v), hits: best.c.hits, chain: best.c.chainHits, margin: Math.round(best.c.minMargin), land: Math.round(best.c.land), runway: Math.round(best.c.runway), rejump: best.c.rejump ? best.c.rejump.hold : null, first: first.kind + "@" + Math.round(first.a - S.x), cleared: [...best.c.cleared] });

        if (best.c.rejump) {
          // Predict the landing frame and spam taps across its uncertainty window;
          // whichever press lands in the frame gap right after touchdown takes.
          const arc = arcTable(best.c.hold);
          let kLand = arc.h.length - 1;
          for (let k = 1; k < arc.h.length; k++) {
            const x = best.c.xA + S.v * k * DT;
            if (overPit(world, x)) continue;
            if (arc.h[k] <= 0 && arc.u[k] <= 0) { kLand = k; break; }
          }
          const tTakeoffMin = tDown + KEY_LATENCY_MS, tTakeoffMax = tTakeoffMin + FRAME_MS;
          const tLandMin = tTakeoffMin + kLand * FRAME_MS - 12, tLandMax = tTakeoffMax + kLand * FRAME_MS + 12;
          logEvent({ ev: "rejump-sched", kLand, from: Math.round(tLandMin - tNow), to: Math.round(tLandMax + FRAME_MS - tNow), hold: best.c.rejump.hold, chainHits: best.c.rejump.hits });
          await spamRejump(actions, tLandMin, tLandMax + FRAME_MS + 4, best.c.rejump.hold);
          S.jump = { tDown: now(), hold: best.c.rejump.hold, xA: null, holdEff: best.c.rejump.hold, plan: null };
        }
      }
    }
  }
  if (pressed) return;

  // ---- tunnel hops (only when no hurdle press was needed) ----
  if (tun) {
    const mode = tunnelChooseMode(tun);
    if (mode !== "ground") {
      const hold = mode === "hold" ? HOLD_MAX_FRAMES : 0;
      const xA = Math.ceil(S.x + 2);
      const c = evalCandidate(S.x, xA, S.v, hold, world, false);
      if (c.hits + c.chainHits === 0 && !c.rejump) {
        const tDown = await pressJump(actions, hold);
        S.jump = { tDown, hold, xA: null, holdEff: hold, plan: c };
        tun.flight = mode;
        logEvent({ ev: "tunnel-hop", mode, x: Math.round(S.x), modes: tun.modes });
      }
    }
  }
}

export default {
  name: "fable-v1",
  async reset() {
    if (S) for (const id of S.timers) clearTimeout(id);
    S = freshState();
    arcTable(0); arcTable(HOLD_MAX_FRAMES); arcTable(6); arcTable(9);
  },
  async tick(state, actions) {
    if (!S) S = freshState();
    if (state.phase === "setup") {
      if (!S.started) {
        S.started = true;
        S.wantLong = true;
        logEvent({ ev: "start", dir: state.direction, idx: state.ladderIdx });
        await actions.press(" ", 30);
      }
      return;
    }
    if (state.phase !== "running") {
      if (state.phase === "gameover") logEvent({ ev: "gameover", cause: state.deathCause, hwm: state.hwmTicks, dist: Math.round(state.rampDistancePx) });
      return;
    }
    if (S.busy) return;
    S.busy = true;
    try { await onTick(state, actions); }
    catch (e) { logEvent({ ev: "error", msg: String(e && e.stack || e) }); }
    finally { S.busy = false; }
  },
};
