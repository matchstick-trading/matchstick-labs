#!/usr/bin/env node
/**
 * Generate synthetic backtest runs for Backtest Autopsy.
 * Each run is 60 daily bars plus 8 orders. One of five structural failures is
 * seeded into a minority of runs (or none, for a clean run). Cheap bucketed
 * diagnostics are computed for every run so Jev can triage before anyone pays
 * to run the definitive per-family check.
 * Output: corpus.json (runs + cheap diagnostics) and labels.json (hidden
 * ground truth: the actual injected failure family).
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Seeded PRNG (mulberry32) ---
function prng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussianPair(rng) {
  const u1 = rng(), u2 = rng();
  const r = Math.sqrt(-2 * Math.log(u1 || 1e-10));
  return [r * Math.cos(2 * Math.PI * u2), r * Math.sin(2 * Math.PI * u2)];
}

function round(n) { return Math.round(n * 100) / 100; }

const SESSION_START = 9.5;
const SESSION_END = 16.0;

// --- Bars ---

function genBars(rng) {
  const bars = [];
  const basePrice = 20 + rng() * 200;
  let price = basePrice;
  const baseVol = 1e6 + rng() * 9e6;
  const drift = (rng() - 0.5) * 0.002;

  for (let i = 0; i < 60; i++) {
    const [g] = gaussianPair(rng);
    price += (drift + g * 0.01) * basePrice;
    price = Math.max(1, price);
    const h = price * (1 + rng() * 0.01);
    const l = price * (1 - rng() * 0.01);
    bars.push({
      t: 1700000000 + i * 86400,
      o: round(price + (rng() - 0.5) * 0.3),
      h: round(h),
      l: round(l),
      c: round(price),
      v: Math.round(baseVol * (0.6 + rng() * 0.8)),
    });
  }
  return bars;
}

// --- Orders (clean baseline) ---

function genOrders(rng, bars) {
  const n = 8;
  const orders = [];
  for (let i = 0; i < n; i++) {
    const barIndex = 4 + Math.floor((i * (bars.length - 8)) / n);
    const bar = bars[barIndex];

    const tSignal = bar.t + Math.floor(rng() * 3600);
    const tSubmit = tSignal + 1 + Math.floor(rng() * 30);
    const tFill = tSubmit + 1 + Math.floor(rng() * 30);

    const fillPrice = round(bar.l + rng() * (bar.h - bar.l));
    const fillQty = Math.round(bar.v * (0.02 + rng() * 0.08));
    const localHour = round(SESSION_START + rng() * (SESSION_END - SESSION_START));

    orders.push({
      id: `ord-${i + 1}`,
      bar_index: barIndex,
      t_signal: tSignal,
      t_submit: tSubmit,
      t_fill: tFill,
      fill_price: fillPrice,
      fill_qty: fillQty,
      feature_asof_offset_bars: 0,
      fill_local_hour: localHour,
    });
  }
  return orders;
}

// --- Injections (one per failure family, mutate orders/bars/corp actions) ---

function injectLookahead(rng, orders) {
  const k = 1 + Math.floor(rng() * 4); // 1-4 of 8 orders
  const idx = pickDistinct(rng, orders.length, k);
  for (const i of idx) {
    orders[i].feature_asof_offset_bars = 1 + Math.floor(rng() * 2); // 1-2 bars ahead
  }
  return { count: k };
}

function injectTimezone(rng, orders) {
  const shift = (rng() < 0.5 ? 1 : -1) * (4 + rng() * 2); // ~4-6h consistent offset
  for (const o of orders) {
    let h = o.fill_local_hour + shift;
    h = ((h % 24) + 24) % 24;
    o.fill_local_hour = round(h);
  }
  return { shiftHours: shift };
}

function injectCorpAction(rng, bars) {
  const j = 20 + Math.floor(rng() * 25); // bar 20-44
  const jump = 0.10 + rng() * 0.35; // 10%-45% unexplained overnight move
  const sign = rng() < 0.5 ? -1 : 1;
  for (let i = j; i < bars.length; i++) {
    bars[i].o = round(bars[i].o * (1 + sign * jump));
    bars[i].h = round(bars[i].h * (1 + sign * jump));
    bars[i].l = round(bars[i].l * (1 + sign * jump));
    bars[i].c = round(bars[i].c * (1 + sign * jump));
  }
  return { barIndex: j, magnitude: jump, corporateActions: [{ bar_index: j, type: sign < 0 ? 'reverse_split' : 'split', recorded_factor: null }] };
}

function injectEventOrdering(rng, orders) {
  const c = 1 + Math.floor(rng() * 3); // 1-3 of 8
  const idx = pickDistinct(rng, orders.length, c);
  for (const i of idx) {
    const o = orders[i];
    if (rng() < 0.5) {
      // fill recorded before submission
      o.t_fill = o.t_submit - (1 + Math.floor(rng() * 20));
    } else {
      // submission recorded before signal
      o.t_submit = o.t_signal - (1 + Math.floor(rng() * 20));
    }
  }
  return { count: c };
}

function injectUnrealisticFills(rng, orders, bars) {
  const f = 1 + Math.floor(rng() * 3); // 1-3 of 8
  const idx = pickDistinct(rng, orders.length, f);
  for (const i of idx) {
    const o = orders[i];
    const bar = bars[o.bar_index];
    if (rng() < 0.5) {
      const breach = bar.h * (0.01 + rng() * 0.05);
      o.fill_price = round(rng() < 0.5 ? bar.h + breach : bar.l - breach);
    } else {
      o.fill_qty = Math.round(bar.v * (1.5 + rng() * 3));
    }
  }
  return { count: f };
}

function pickDistinct(rng, n, k) {
  const pool = Array.from({ length: n }, (_, i) => i);
  const picked = [];
  for (let i = 0; i < Math.min(k, n); i++) {
    const j = Math.floor(rng() * pool.length);
    picked.push(pool.splice(j, 1)[0]);
  }
  return picked;
}

// --- Cheap diagnostics (computed identically for every run) ---

function bucket4(x, t1, t2, t3) {
  if (x <= t1) return 'none';
  if (x <= t2) return 'mild';
  if (x <= t3) return 'notable';
  return 'severe';
}

function computeDiagnostics(rng, run) {
  const { orders, bars } = run;
  const n = orders.length;

  const leakCount = orders.filter(o => o.feature_asof_offset_bars > 0).length;
  const futureAsofRate = leakCount / n + rng() * 0.06;

  const outsideCount = orders.filter(o => o.fill_local_hour < 9.0 || o.fill_local_hour > 16.5).length;
  const sessionOffsetRate = outsideCount / n + rng() * 0.06;

  let maxOvernight = 0;
  for (let i = 1; i < bars.length; i++) {
    const r = Math.abs(bars[i].o - bars[i - 1].c) / bars[i - 1].c;
    if (r > maxOvernight) maxOvernight = r;
  }
  const priceDiscontinuity = maxOvernight + rng() * 0.03;

  const causalityCount = orders.filter(o => o.t_fill < o.t_submit || o.t_submit < o.t_signal).length;

  const fillCount = orders.filter(o => {
    const bar = bars[o.bar_index];
    return o.fill_price < bar.l || o.fill_price > bar.h || o.fill_qty > bar.v;
  }).length;

  return {
    future_asof_rate: bucket4(futureAsofRate, 0.05, 0.20, 0.40),
    session_offset: bucket4(sessionOffsetRate, 0.05, 0.20, 0.40),
    price_discontinuity: bucket4(priceDiscontinuity, 0.06, 0.15, 0.30),
    causality_violations: bucket4(causalityCount / n, 0.05, 0.20, 0.40),
    fill_implausibility: bucket4(fillCount / n, 0.05, 0.20, 0.40),
    _raw: { futureAsofRate, sessionOffsetRate, maxOvernight, causalityCount, fillCount },
  };
}

// --- Family descriptions for labels.json ---

function familyDescription(family) {
  const descs = {
    lookahead_leakage: 'One or more orders were decided using feature data timestamped after the decision bar closed.',
    timezone_mismatch: 'Fill timestamps are shifted by a consistent multi-hour offset outside the declared trading session.',
    bad_corporate_action_adjustment: 'An unexplained large overnight price move has no matching recorded split or dividend factor.',
    event_ordering_violation: 'One or more orders record a fill before its submission, or a submission before its signal.',
    unrealistic_fills: 'One or more fills sit outside the bar’s high-low range or exceed the bar’s traded volume.',
  };
  return descs[family] ?? '';
}

// --- Generate corpus ---

const FAMILIES = [
  { key: 'lookahead_leakage', prefix: 'lla', count: 6, inject: (rng, run) => injectLookahead(rng, run.orders) },
  { key: 'timezone_mismatch', prefix: 'tzm', count: 6, inject: (rng, run) => injectTimezone(rng, run.orders) },
  { key: 'bad_corporate_action_adjustment', prefix: 'bca', count: 6, inject: (rng, run) => {
      const r = injectCorpAction(rng, run.bars);
      run.corporate_actions = r.corporateActions;
      return r;
    } },
  { key: 'event_ordering_violation', prefix: 'eov', count: 6, inject: (rng, run) => injectEventOrdering(rng, run.orders) },
  { key: 'unrealistic_fills', prefix: 'urf', count: 6, inject: (rng, run) => injectUnrealisticFills(rng, run.orders, run.bars) },
];

const runs = [];
const labels = [];
let seedCounter = 2000;

for (const { key, prefix, count, inject } of FAMILIES) {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${String(i + 1).padStart(2, '0')}`;
    const rng = prng(seedCounter++);
    const bars = genBars(rng);
    const orders = genOrders(rng, bars);
    const run = { id, bars, orders, corporate_actions: [] };
    inject(rng, run);
    const computed = computeDiagnostics(rng, run);

    runs.push({ id, provenance: 'synthetic', bars: run.bars, orders: run.orders, corporate_actions: run.corporate_actions, computed });
    labels.push({ run_id: id, failure: { type: key, description: familyDescription(key), confidence: 'definite' } });
  }
}

// Clean runs
for (let i = 0; i < 15; i++) {
  const id = `cln-${String(i + 1).padStart(2, '0')}`;
  const rng = prng(seedCounter++);
  const bars = genBars(rng);
  const orders = genOrders(rng, bars);
  const run = { id, bars, orders, corporate_actions: [] };
  const computed = computeDiagnostics(rng, run);

  runs.push({ id, provenance: 'synthetic', bars: run.bars, orders: run.orders, corporate_actions: run.corporate_actions, computed });
  labels.push({ run_id: id, failure: null });
}

writeFileSync(join(__dirname, 'corpus.json'), JSON.stringify(runs, null, 2));
writeFileSync(join(__dirname, 'labels.json'), JSON.stringify(labels, null, 2));

console.log(`Generated ${runs.length} runs (${runs.length - 15} seeded failures, 15 clean)`);
console.log(`Wrote corpus.json (${(JSON.stringify(runs).length / 1024).toFixed(0)} KB)`);
console.log(`Wrote labels.json (${(JSON.stringify(labels).length / 1024).toFixed(0)} KB)`);
