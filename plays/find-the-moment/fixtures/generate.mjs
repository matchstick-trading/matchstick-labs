#!/usr/bin/env node
/**
 * Generate synthetic fixture windows for Find the Moment.
 * Each window is 60 bars of synthetic OHLCV with a seeded episode type.
 * Output: corpus.json (windows + computed features) and labels.json (hidden ground truth).
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

// --- Episode generators ---

function genFailedBreakout(rng, id) {
  const bars = [];
  const basePrice = 40 + rng() * 160;
  const rangeHigh = basePrice * (1 + 0.03 + rng() * 0.04);
  const rangeLow = basePrice * (1 - 0.03 - rng() * 0.04);
  let price = basePrice;
  const baseVol = 1e6 + rng() * 9e6;

  // Phase 1: range-bound (bars 0-34)
  for (let i = 0; i < 35; i++) {
    const [g] = gaussianPair(rng);
    const drift = (basePrice - price) * 0.05;
    price = Math.max(rangeLow * 0.98, Math.min(rangeHigh * 1.02, price + drift + g * basePrice * 0.008));
    const h = price * (1 + rng() * 0.012);
    const l = price * (1 - rng() * 0.012);
    bars.push({ t: 1700000000 + i * 86400, o: round(price + (rng() - 0.5) * 0.5), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (0.7 + rng() * 0.6)) });
  }

  // Phase 2: breakout above range (bars 35-42) with volume spike
  for (let i = 35; i < 43; i++) {
    price += basePrice * (0.004 + rng() * 0.006);
    const h = price * (1 + rng() * 0.015);
    const l = price * (1 - rng() * 0.005);
    bars.push({ t: 1700000000 + i * 86400, o: round(price - rng() * 0.3), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (1.5 + rng() * 2.0)) });
  }

  // Phase 3: failure — price returns inside range quickly (bars 43-59)
  for (let i = 43; i < 60; i++) {
    price -= basePrice * (0.005 + rng() * 0.008);
    price = Math.max(rangeLow * 0.95, price);
    const h = price * (1 + rng() * 0.01);
    const l = price * (1 - rng() * 0.015);
    bars.push({ t: 1700000000 + i * 86400, o: round(price + rng() * 0.4), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (0.8 + rng() * 1.0)) });
  }

  return { id, bars, episode: 'failed_upside_breakout', confidence: 'definite' };
}

function genTrendExhaustion(rng, id) {
  const bars = [];
  const basePrice = 50 + rng() * 150;
  let price = basePrice;
  const baseVol = 1e6 + rng() * 9e6;

  // Phase 1: strong uptrend (bars 0-34) with healthy volume
  for (let i = 0; i < 35; i++) {
    price += basePrice * (0.003 + rng() * 0.005);
    const h = price * (1 + rng() * 0.01);
    const l = price * (1 - rng() * 0.006);
    bars.push({ t: 1700000000 + i * 86400, o: round(price - rng() * 0.3), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (1.0 + rng() * 0.8)) });
  }

  // Phase 2: exhaustion — price stalls, volume declines (bars 35-49)
  for (let i = 35; i < 50; i++) {
    const [g] = gaussianPair(rng);
    price += g * basePrice * 0.003;
    const h = price * (1 + rng() * 0.008);
    const l = price * (1 - rng() * 0.008);
    const volDecay = 1.0 - (i - 35) * 0.05;
    bars.push({ t: 1700000000 + i * 86400, o: round(price + (rng() - 0.5) * 0.3), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * volDecay * (0.5 + rng() * 0.3)) });
  }

  // Phase 3: squeeze/compression (bars 50-59)
  for (let i = 50; i < 60; i++) {
    const [g] = gaussianPair(rng);
    price += g * basePrice * 0.001;
    const range = basePrice * 0.003 * (1 - (i - 50) * 0.08);
    const h = price + Math.abs(range);
    const l = price - Math.abs(range);
    bars.push({ t: 1700000000 + i * 86400, o: round(price), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * 0.3 * (0.4 + rng() * 0.3)) });
  }

  return { id, bars, episode: 'trend_exhaustion', confidence: 'definite' };
}

function genGapContinuation(rng, id) {
  const bars = [];
  const basePrice = 30 + rng() * 170;
  let price = basePrice;
  const baseVol = 1e6 + rng() * 9e6;

  // Phase 1: mild uptrend (bars 0-29)
  for (let i = 0; i < 30; i++) {
    price += basePrice * (0.001 + rng() * 0.003);
    const h = price * (1 + rng() * 0.01);
    const l = price * (1 - rng() * 0.008);
    bars.push({ t: 1700000000 + i * 86400, o: round(price - rng() * 0.2), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (0.7 + rng() * 0.6)) });
  }

  // Phase 2: gap up (bar 30) — open significantly above previous close
  const gapSize = basePrice * (0.02 + rng() * 0.04);
  price += gapSize;
  const gapBar = { t: 1700000000 + 30 * 86400, o: round(price), h: round(price * (1 + rng() * 0.02)), l: round(price * (1 - rng() * 0.005)), c: round(price * (1 + rng() * 0.01)), v: Math.round(baseVol * (2.5 + rng() * 3.0)) };
  price = gapBar.c;
  bars.push(gapBar);

  // Phase 3: continuation — price trends higher after gap (bars 31-59)
  for (let i = 31; i < 60; i++) {
    price += basePrice * (0.002 + rng() * 0.004);
    const h = price * (1 + rng() * 0.01);
    const l = price * (1 - rng() * 0.006);
    const volDecay = Math.max(0.5, 2.0 - (i - 31) * 0.05);
    bars.push({ t: 1700000000 + i * 86400, o: round(price - rng() * 0.3), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * volDecay * (0.8 + rng() * 0.4)) });
  }

  return { id, bars, episode: 'gap_continuation', confidence: 'definite' };
}

function genFalseBreakdown(rng, id) {
  const bars = [];
  const basePrice = 40 + rng() * 160;
  const rangeHigh = basePrice * (1 + 0.04 + rng() * 0.03);
  const rangeLow = basePrice * (1 - 0.04 - rng() * 0.03);
  let price = basePrice;
  const baseVol = 1e6 + rng() * 9e6;

  // Phase 1: range with accumulation (bars 0-39) — volume rising near lows
  for (let i = 0; i < 40; i++) {
    const [g] = gaussianPair(rng);
    const drift = (basePrice - price) * 0.03;
    price = Math.max(rangeLow * 0.97, Math.min(rangeHigh * 1.03, price + drift + g * basePrice * 0.007));
    const h = price * (1 + rng() * 0.01);
    const l = price * (1 - rng() * 0.01);
    const nearLow = Math.max(0, 1 - (price - rangeLow) / (rangeHigh - rangeLow));
    bars.push({ t: 1700000000 + i * 86400, o: round(price + (rng() - 0.5) * 0.3), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (0.6 + nearLow * 0.8 + rng() * 0.3)) });
  }

  // Phase 2: false breakdown (bars 40-47) — brief drop below range
  for (let i = 40; i < 48; i++) {
    price -= basePrice * (0.003 + rng() * 0.005);
    const h = price * (1 + rng() * 0.008);
    const l = price * (1 - rng() * 0.012);
    bars.push({ t: 1700000000 + i * 86400, o: round(price + rng() * 0.3), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (1.2 + rng() * 1.5)) });
  }

  // Phase 3: reversal back into range (bars 48-59)
  for (let i = 48; i < 60; i++) {
    price += basePrice * (0.004 + rng() * 0.006);
    price = Math.min(rangeHigh * 1.05, price);
    const h = price * (1 + rng() * 0.01);
    const l = price * (1 - rng() * 0.006);
    bars.push({ t: 1700000000 + i * 86400, o: round(price - rng() * 0.3), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (1.0 + rng() * 0.8)) });
  }

  return { id, bars, episode: 'false_breakdown', confidence: 'definite' };
}

function genVolSqueeze(rng, id) {
  const bars = [];
  const basePrice = 50 + rng() * 150;
  let price = basePrice;
  const baseVol = 1e6 + rng() * 9e6;

  // Phase 1: normal trading (bars 0-24)
  for (let i = 0; i < 25; i++) {
    const [g] = gaussianPair(rng);
    price += g * basePrice * 0.006;
    const h = price * (1 + rng() * 0.012);
    const l = price * (1 - rng() * 0.012);
    bars.push({ t: 1700000000 + i * 86400, o: round(price + (rng() - 0.5) * 0.4), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (0.8 + rng() * 0.6)) });
  }

  // Phase 2: compression — narrowing range, declining volume (bars 25-49)
  for (let i = 25; i < 50; i++) {
    const [g] = gaussianPair(rng);
    const compression = 1 - (i - 25) * 0.035;
    price += g * basePrice * 0.006 * Math.max(0.1, compression);
    const range = basePrice * 0.012 * Math.max(0.1, compression);
    bars.push({ t: 1700000000 + i * 86400, o: round(price), h: round(price + range * rng()), l: round(price - range * rng()), c: round(price), v: Math.round(baseVol * Math.max(0.2, compression) * (0.5 + rng() * 0.3)) });
  }

  // Phase 3: expansion — big move with volume (bars 50-59)
  const direction = rng() > 0.5 ? 1 : -1;
  for (let i = 50; i < 60; i++) {
    price += direction * basePrice * (0.008 + rng() * 0.01);
    const h = price * (1 + rng() * 0.015);
    const l = price * (1 - rng() * 0.015);
    bars.push({ t: 1700000000 + i * 86400, o: round(price - direction * rng() * 0.5), h: round(Math.max(h, l)), l: round(Math.min(h, l)), c: round(price), v: Math.round(baseVol * (2.0 + rng() * 3.0)) });
  }

  return { id, bars, episode: 'volatility_squeeze', confidence: 'definite' };
}

function genDistractor(rng, id) {
  const bars = [];
  const basePrice = 20 + rng() * 200;
  let price = basePrice;
  const baseVol = 1e6 + rng() * 9e6;
  const drift = (rng() - 0.5) * 0.003;

  for (let i = 0; i < 60; i++) {
    const [g] = gaussianPair(rng);
    price += (drift + g * 0.008) * basePrice;
    price = Math.max(1, price);
    const h = price * (1 + rng() * 0.012);
    const l = price * (1 - rng() * 0.012);
    bars.push({ t: 1700000000 + i * 86400, o: round(price + (rng() - 0.5) * 0.3), h: round(h), l: round(l), c: round(price), v: Math.round(baseVol * (0.5 + rng() * 1.0)) });
  }

  return { id, bars, episode: null, confidence: null };
}

function round(n) { return Math.round(n * 100) / 100; }

// --- Feature computation ---

function computeFeatures(bars) {
  const n = bars.length;
  const last = bars[n - 1];
  const first = bars[0];

  // Returns
  const totalReturn = (last.c - first.c) / first.c;
  const halfReturn = (last.c - bars[Math.floor(n / 2)].c) / bars[Math.floor(n / 2)].c;

  // Volatility (std of daily returns)
  const returns = [];
  for (let i = 1; i < n; i++) returns.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c);
  const meanRet = returns.reduce((a, b) => a + b, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((a, r) => a + (r - meanRet) ** 2, 0) / returns.length);

  // Volume trend (second half vs first half)
  const halfIdx = Math.floor(n / 2);
  const volFirst = bars.slice(0, halfIdx).reduce((a, b) => a + b.v, 0) / halfIdx;
  const volSecond = bars.slice(halfIdx).reduce((a, b) => a + b.v, 0) / (n - halfIdx);
  const volumeTrend = volFirst > 0 ? (volSecond - volFirst) / volFirst : 0;

  // Range position (current price relative to high-low range)
  const high = Math.max(...bars.map(b => b.h));
  const low = Math.min(...bars.map(b => b.l));
  const rangePos = high > low ? (last.c - low) / (high - low) : 0.5;

  // Gap detection (largest gap)
  let maxGap = 0;
  let maxGapIdx = -1;
  for (let i = 1; i < n; i++) {
    const gap = Math.abs(bars[i].o - bars[i - 1].c) / bars[i - 1].c;
    if (gap > maxGap) { maxGap = gap; maxGapIdx = i; }
  }

  // ATR (14-period)
  const atrBars = Math.min(14, n - 1);
  let atrSum = 0;
  for (let i = n - atrBars; i < n; i++) {
    const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    atrSum += tr;
  }
  const atr = atrSum / atrBars;
  const atrPct = atr / last.c;

  // Late vs early ATR (compression detection)
  const earlyAtr = computeAtr(bars, 0, Math.min(14, halfIdx));
  const lateAtr = computeAtr(bars, Math.max(0, n - 15), n - 1);
  const atrRatio = earlyAtr > 0 ? lateAtr / earlyAtr : 1;

  // Bucketed features for Jev
  return {
    total_return: bucketReturn(totalReturn),
    half_return: bucketReturn(halfReturn),
    volatility: bucketVol(vol),
    volume_trend: bucketVolTrend(volumeTrend),
    range_position: bucketRangePos(rangePos),
    gap_magnitude: bucketGap(maxGap),
    atr_compression: bucketAtrRatio(atrRatio),
    // Raw values for scoring
    _raw: { totalReturn, halfReturn, vol, volumeTrend, rangePos, maxGap, maxGapIdx, atrPct, atrRatio },
  };
}

function computeAtr(bars, start, end) {
  let sum = 0, count = 0;
  for (let i = Math.max(1, start); i <= end && i < bars.length; i++) {
    sum += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function bucketReturn(r) {
  if (r > 0.15) return 'strong_up';
  if (r > 0.05) return 'up';
  if (r > -0.05) return 'flat';
  if (r > -0.15) return 'down';
  return 'strong_down';
}

function bucketVol(v) {
  if (v > 0.03) return 'extreme';
  if (v > 0.02) return 'elevated';
  if (v > 0.008) return 'normal';
  return 'compressed';
}

function bucketVolTrend(vt) {
  if (vt > 0.5) return 'surging';
  if (vt > 0.15) return 'rising';
  if (vt > -0.15) return 'steady';
  if (vt > -0.5) return 'declining';
  return 'drying_up';
}

function bucketRangePos(rp) {
  if (rp > 0.8) return 'near_high';
  if (rp > 0.6) return 'upper';
  if (rp > 0.4) return 'middle';
  if (rp > 0.2) return 'lower';
  return 'near_low';
}

function bucketGap(g) {
  if (g > 0.04) return 'large';
  if (g > 0.02) return 'notable';
  if (g > 0.005) return 'small';
  return 'none';
}

function bucketAtrRatio(r) {
  if (r > 1.5) return 'expanding';
  if (r > 0.8) return 'stable';
  if (r > 0.4) return 'contracting';
  return 'squeezed';
}

// --- Generate corpus ---

const EPISODE_GENERATORS = [
  { gen: genFailedBreakout, count: 4, type: 'failed_upside_breakout' },
  { gen: genTrendExhaustion, count: 4, type: 'trend_exhaustion' },
  { gen: genGapContinuation, count: 4, type: 'gap_continuation' },
  { gen: genFalseBreakdown, count: 4, type: 'false_breakdown' },
  { gen: genVolSqueeze, count: 4, type: 'volatility_squeeze' },
];

const windows = [];
const labels = [];
let seedCounter = 1000;

for (const { gen, count, type } of EPISODE_GENERATORS) {
  for (let i = 0; i < count; i++) {
    const id = `${type.slice(0, 3)}-${String(i + 1).padStart(2, '0')}`;
    const rng = prng(seedCounter++);
    const result = gen(rng, id);
    const features = computeFeatures(result.bars);

    windows.push({
      id: result.id,
      provenance: 'synthetic',
      bars: result.bars,
      computed: features,
    });

    labels.push({
      window_id: result.id,
      episodes: [{
        type: result.episode,
        description: episodeDescription(result.episode),
        confidence: result.confidence,
      }],
    });
  }
}

// Distractors
for (let i = 0; i < 20; i++) {
  const id = `dis-${String(i + 1).padStart(2, '0')}`;
  const rng = prng(seedCounter++);
  const result = genDistractor(rng, id);
  const features = computeFeatures(result.bars);

  windows.push({
    id: result.id,
    provenance: 'synthetic',
    bars: result.bars,
    computed: features,
  });

  labels.push({
    window_id: result.id,
    episodes: [],
  });
}

function episodeDescription(type) {
  const descs = {
    failed_upside_breakout: 'Price broke above a trading range but failed to hold, returning inside the range quickly.',
    trend_exhaustion: 'A sustained trend stalled with declining volume and narrowing range, signaling exhaustion.',
    gap_continuation: 'A gap opening in the direction of the prior trend that held and continued higher.',
    false_breakdown: 'Price briefly broke below a range but reversed, trapping sellers in a false move.',
    volatility_squeeze: 'Volatility compressed to historic lows before an expansion move in either direction.',
  };
  return descs[type] ?? '';
}

// Write output
writeFileSync(join(__dirname, 'corpus.json'), JSON.stringify(windows, null, 2));
writeFileSync(join(__dirname, 'labels.json'), JSON.stringify(labels, null, 2));

console.log(`Generated ${windows.length} windows (${windows.length - 20} episodes, 20 distractors)`);
console.log(`Wrote corpus.json (${(JSON.stringify(windows).length / 1024).toFixed(0)} KB)`);
console.log(`Wrote labels.json (${(JSON.stringify(labels).length / 1024).toFixed(0)} KB)`);
