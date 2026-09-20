#!/usr/bin/env node
/**
 * Generate synthetic tick/quote feed runs for Market Data Incident Lab.
 * Each run is a 50-tick trade + quote stream. One of five feed incidents is
 * seeded into a minority of runs; a few "clean" runs carry a genuine,
 * explained price discontinuity as a hard negative. Cheap bucketed
 * diagnostics are computed for every run so Jev can triage before anyone
 * pays to run the definitive per-family check.
 * Output: corpus.json (runs + cheap diagnostics) and labels.json (hidden
 * ground truth: the actual injected incident family).
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

const N = 50;

// --- Baseline tick + quote stream ---

function genStream(rng) {
  const basePrice = 20 + rng() * 200;
  let price = basePrice;
  const ticks = [];
  const quotes = [];
  let t = 1700000000;

  for (let i = 0; i < N; i++) {
    const [g] = gaussianPair(rng);
    price += g * basePrice * 0.003;
    price = Math.max(1, price);
    t += 2 + Math.floor(rng() * 3);

    ticks.push({ seq: i + 1, t, price: round(price), size: Math.round(100 + rng() * 900) });

    const spread = Math.max(0.01, price * 0.0005 * (1 + rng()));
    // Occasional benign quote staleness: book doesn't refresh every print.
    if (i > 0 && rng() < 0.08) {
      quotes.push({ ...quotes[i - 1], seq: i + 1 });
    } else {
      quotes.push({
        seq: i + 1,
        bid: round(price - spread / 2),
        ask: round(price + spread / 2),
        bid_size: Math.round(100 + rng() * 500),
        ask_size: Math.round(100 + rng() * 500),
      });
    }
  }
  return { ticks, quotes };
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

// --- Injections ---

function injectStaleQuote(rng, run) {
  const runLen = 6 + Math.floor(rng() * 10); // 6-15 consecutive frozen quotes
  const start = 5 + Math.floor(rng() * (N - runLen - 8));
  const frozen = { ...run.quotes[start] };
  for (let i = start; i < start + runLen; i++) {
    run.quotes[i] = { ...frozen, seq: i + 1 };
  }
  return { start, runLen };
}

function injectCrossedBook(rng, run) {
  const m = 1 + Math.floor(rng() * 3); // 1-3
  const idx = pickDistinct(rng, N, m);
  for (const i of idx) {
    const q = run.quotes[i];
    const cross = 0.01 + rng() * 0.04;
    run.quotes[i] = { ...q, bid: round(q.ask + cross) };
  }
  return { count: m };
}

function injectDuplicateTick(rng, run) {
  const d = 1 + Math.floor(rng() * 3); // 1-3
  const idx = pickDistinct(rng, N - 1, d).map(i => i + 1); // never index 0
  for (const i of idx) {
    run.ticks[i] = { ...run.ticks[i - 1], seq: run.ticks[i].seq };
  }
  return { count: d };
}

function injectOutOfOrder(rng, run) {
  const c = 1 + Math.floor(rng() * 3); // 1-3
  const idx = pickDistinct(rng, N - 1, c).map(i => i + 1);
  for (const i of idx) {
    run.ticks[i] = { ...run.ticks[i], t: run.ticks[i - 1].t - (1 + Math.floor(rng() * 5)) };
  }
  return { count: c };
}

function injectPriceJump(rng, run, recordEvent) {
  const j = 10 + Math.floor(rng() * 30); // tick 10-39
  const jump = 0.08 + rng() * 0.35;
  const sign = rng() < 0.5 ? -1 : 1;
  for (let i = j; i < run.ticks.length; i++) {
    run.ticks[i] = { ...run.ticks[i], price: round(run.ticks[i].price * (1 + sign * jump)) };
  }
  for (let i = j; i < run.quotes.length; i++) {
    const spread = Math.max(0.01, run.ticks[i].price * 0.0005 * 1.3);
    run.quotes[i] = { ...run.quotes[i], bid: round(run.ticks[i].price - spread / 2), ask: round(run.ticks[i].price + spread / 2) };
  }
  if (recordEvent) {
    const type = rng() < 0.5 ? 'earnings' : 'halt_resume';
    run.events = [{ tick_index: j, type, note: `${type.replace('_', ' ')} — price move is explained` }];
  }
  return { tickIndex: j, magnitude: jump };
}

// --- Cheap diagnostics ---

function bucketCount(c) {
  if (c === 0) return 'none';
  if (c === 1) return 'mild';
  if (c <= 2) return 'notable';
  return 'severe';
}

function bucketRunLength(len) {
  if (len < 3) return 'none';
  if (len < 6) return 'mild';
  if (len < 10) return 'notable';
  return 'severe';
}

function bucketMagnitude(m) {
  if (m < 0.05) return 'none';
  if (m < 0.12) return 'mild';
  if (m < 0.25) return 'notable';
  return 'severe';
}

function computeDiagnostics(rng, run) {
  const { ticks, quotes } = run;

  let longestStale = 0, current = 1;
  for (let i = 1; i < quotes.length; i++) {
    if (quotes[i].bid === quotes[i - 1].bid && quotes[i].ask === quotes[i - 1].ask) {
      current++;
    } else {
      longestStale = Math.max(longestStale, current);
      current = 1;
    }
  }
  longestStale = Math.max(longestStale, current);

  const crossCount = quotes.filter(q => q.bid >= q.ask).length;
  const dupCount = ticks.filter((tk, i) => i > 0 && tk.t === ticks[i - 1].t && tk.price === ticks[i - 1].price && tk.size === ticks[i - 1].size).length;
  const oooCount = ticks.filter((tk, i) => i > 0 && tk.t < ticks[i - 1].t).length;

  let maxJump = 0;
  for (let i = 1; i < ticks.length; i++) {
    const r = Math.abs(ticks[i].price - ticks[i - 1].price) / ticks[i - 1].price;
    if (r > maxJump) maxJump = r;
  }

  return {
    quote_staleness: bucketRunLength(longestStale),
    cross_rate: bucketCount(crossCount),
    duplicate_rate: bucketCount(dupCount),
    sequence_violations: bucketCount(oooCount),
    price_jump: bucketMagnitude(maxJump + rng() * 0.02),
    _raw: { longestStale, crossCount, dupCount, oooCount, maxJump },
  };
}

// --- Family descriptions ---

function familyDescription(family) {
  const descs = {
    stale_quote: 'The bid/ask quote froze for a long run of consecutive prints while trades kept occurring.',
    crossed_book: 'One or more quotes show the bid at or above the ask.',
    duplicate_tick: 'One or more trade prints are exact duplicates of the print immediately before them.',
    out_of_order_event: 'One or more trade prints arrived timestamped earlier than the print immediately before them.',
    unadjusted_split: 'An unexplained large single-print price jump has no recorded corporate-action or news event behind it.',
  };
  return descs[family] ?? '';
}

// --- Generate corpus ---

const FAMILIES = [
  { key: 'stale_quote', prefix: 'stq', count: 6, inject: (rng, run) => injectStaleQuote(rng, run) },
  { key: 'crossed_book', prefix: 'crb', count: 6, inject: (rng, run) => injectCrossedBook(rng, run) },
  { key: 'duplicate_tick', prefix: 'dup', count: 6, inject: (rng, run) => injectDuplicateTick(rng, run) },
  { key: 'out_of_order_event', prefix: 'ooo', count: 6, inject: (rng, run) => injectOutOfOrder(rng, run) },
  { key: 'unadjusted_split', prefix: 'uas', count: 6, inject: (rng, run) => injectPriceJump(rng, run, false) },
];

const runs = [];
const labels = [];
let seedCounter = 3000;

for (const { key, prefix, count, inject } of FAMILIES) {
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${String(i + 1).padStart(2, '0')}`;
    const rng = prng(seedCounter++);
    const run = genStream(rng);
    run.events = [];
    inject(rng, run);
    const computed = computeDiagnostics(rng, run);

    runs.push({ id, provenance: 'synthetic', ticks: run.ticks, quotes: run.quotes, events: run.events, computed });
    labels.push({ run_id: id, incident: { type: key, description: familyDescription(key), confidence: 'definite' } });
  }
}

// Clean: 5 genuine-discontinuity hard negatives + 10 plain quiet runs
for (let i = 0; i < 15; i++) {
  const id = `cln-${String(i + 1).padStart(2, '0')}`;
  const rng = prng(seedCounter++);
  const run = genStream(rng);
  run.events = [];
  if (i < 5) injectPriceJump(rng, run, true);
  const computed = computeDiagnostics(rng, run);

  runs.push({ id, provenance: 'synthetic', ticks: run.ticks, quotes: run.quotes, events: run.events, computed });
  labels.push({ run_id: id, incident: null });
}

writeFileSync(join(__dirname, 'corpus.json'), JSON.stringify(runs, null, 2));
writeFileSync(join(__dirname, 'labels.json'), JSON.stringify(labels, null, 2));

console.log(`Generated ${runs.length} runs (${runs.length - 15} seeded incidents, 15 clean, 5 of those with a genuine explained discontinuity)`);
console.log(`Wrote corpus.json (${(JSON.stringify(runs).length / 1024).toFixed(0)} KB)`);
console.log(`Wrote labels.json (${(JSON.stringify(labels).length / 1024).toFixed(0)} KB)`);
