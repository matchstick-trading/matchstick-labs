#!/usr/bin/env node
//
// autoplay-eval.mjs — run a scripted "autoplay" bot policy through the real
// Tape & Ladder game, over a fixed set of seeds, and report objective,
// reproducible scoring stats. Built as the shared "verifiable reward" harness
// for comparing difficulty-tuning attempts (including across different models/
// agents) on equal footing: every candidate is judged by the same measured
// results from the same real physics/collision/hazard code, not a simulation
// and not self-reported feel.
//
// Usage:
//   node scripts/autoplay-eval.mjs <policy-path> [options]
//
// Options:
//   --seeds 1,2,3,4,5      Comma-separated seed list (default: 1..10)
//   --play-dir <path>      Defaults to plays/tape-and-ladder
//   --poll-ms <n>          Decision-tick interval, ms (default: 40 — ~25Hz,
//                          comfortably tighter than this game's obstacle timescale)
//   --max-ms <n>           Safety timeout per run, ms (default: 120000)
//   --headed               Launch a visible browser instead of headless (debugging)
//   --out <path>           Where to write the full JSON report (default:
//                          results/<policy-name>-<timestamp>.json under play-dir's repo root)
//
// A policy module (see scripts/policies/baseline.mjs for the reference) default-
// exports an object: { name, tick(state, actions), reset() }. `tick` is called
// once per poll interval with the live state from window.__tapeAndLadder.getState()
// and a small `actions` object wrapping Playwright's real page.keyboard — the same
// input path a human uses (see index.html's keydown handler). Policies decide;
// this harness only measures and reports. The policy module is imported once and
// reused across every seed in a batch, so any per-run state (e.g. "have I already
// triggered a jump for this obstacle") must live behind an optional `reset()`,
// which the harness calls before each seed's run.
//
// Self-contained like capture-clip.mjs: opens its own local server, drives the
// page with Playwright, and reports what it produced. Never edits the play's
// source or any policy file.

import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serveDir, waitForHarness, getHarnessState } from "./lib/harness-util.mjs";

function parseArgs(argv) {
  const args = { seeds: null, playDir: "plays/tape-and-ladder", pollMs: 40, maxMs: 120000, headed: false, out: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--seeds") args.seeds = argv[++i].split(",").map((s) => Number(s.trim()));
    else if (a === "--play-dir") args.playDir = argv[++i];
    else if (a === "--poll-ms") args.pollMs = Number(argv[++i]);
    else if (a === "--max-ms") args.maxMs = Number(argv[++i]);
    else if (a === "--headed") args.headed = true;
    else if (a === "--out") args.out = argv[++i];
    else positional.push(a);
  }
  args.policyPath = positional[0];
  if (!args.seeds) args.seeds = Array.from({ length: 10 }, (_, i) => i + 1);
  return args;
}

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function mean(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function makeActions(page) {
  return {
    async keyDown(key) { await page.keyboard.down(key); },
    async keyUp(key) { await page.keyboard.up(key); },
    async press(key, ms = 30) {
      await page.keyboard.down(key);
      await new Promise((r) => setTimeout(r, ms));
      await page.keyboard.up(key);
    },
  };
}

async function runOneSeed({ page, url, seed, policy, pollMs, maxMs }) {
  // "domcontentloaded" not "load": the page pulls a Google Fonts stylesheet
  // (cosmetic only) that can hang the "load" event in network-restricted
  // environments (e.g. a sandboxed CI/agent host). The game script itself needs
  // no external resource, and the waitForFunction below already confirms it ran.
  await page.goto(`${url}?seed=${seed}`, { waitUntil: "domcontentloaded" });
  await waitForHarness(page, 10000);
  const actions = makeActions(page);
  if (typeof policy.reset === "function") await policy.reset();

  const start = Date.now();
  let lastState = null;
  while (Date.now() - start < maxMs) {
    const state = await getHarnessState(page);
    lastState = state;
    if (state.phase === "gameover") break;
    await policy.tick(state, actions);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const timedOut = !lastState || lastState.phase !== "gameover";
  const durationMs = Date.now() - start;
  return {
    seed,
    timedOut,
    durationMs,
    hwmTicks: lastState ? lastState.hwmTicks : null,
    rampDistancePx: lastState ? lastState.rampDistancePx : null,
    deathCause: lastState ? lastState.deathCause : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.policyPath) {
    console.error("Usage: node scripts/autoplay-eval.mjs <policy-path> [--seeds 1,2,3] [--play-dir ...] [--out ...]");
    process.exit(1);
  }
  const playDir = resolve(args.playDir);
  if (!existsSync(join(playDir, "index.html"))) {
    console.error(`No index.html found in ${playDir}`);
    process.exit(1);
  }
  const policyModule = await import(pathToFileURL(resolve(args.policyPath)).href);
  const policy = policyModule.default;
  if (!policy || typeof policy.tick !== "function") {
    console.error(`${args.policyPath} must default-export { name, tick(state, actions) }`);
    process.exit(1);
  }

  const server = serveDir(playDir);
  // Bind and address explicitly by IPv4 loopback: some sandboxed hosts resolve
  // "localhost" to IPv6 first and stall there before falling back, which can look
  // like a hung page.goto with no useful error.
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Serving ${playDir} at ${url}`);
  console.log(`Policy: ${policy.name || basename(args.policyPath)} | seeds: ${args.seeds.join(",")} | poll: ${args.pollMs}ms`);

  const browser = await chromium.launch({ headless: !args.headed });
  const results = [];
  for (const seed of args.seeds) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    const page = await context.newPage();
    try {
      const result = await runOneSeed({ page, url, seed, policy, pollMs: args.pollMs, maxMs: args.maxMs });
      results.push(result);
      console.log(
        `  seed ${seed}: hwmTicks=${result.hwmTicks} distancePx=${Math.round(result.rampDistancePx || 0)} ` +
        `death=${result.deathCause || "(none)"}${result.timedOut ? " [TIMED OUT]" : ""}`
      );
    } finally {
      await context.close();
    }
  }
  await browser.close();
  await new Promise((res) => server.close(res));

  const hwmTicksList = results.map((r) => r.hwmTicks).filter((v) => v != null);
  const distList = results.map((r) => r.rampDistancePx).filter((v) => v != null);
  const deathCauses = {};
  for (const r of results) {
    const c = r.deathCause || "(none/timeout)";
    deathCauses[c] = (deathCauses[c] || 0) + 1;
  }
  const summary = {
    policy: policy.name || basename(args.policyPath),
    seeds: args.seeds,
    pollMs: args.pollMs,
    runCount: results.length,
    timeouts: results.filter((r) => r.timedOut).length,
    hwmTicks: { median: median(hwmTicksList), mean: mean(hwmTicksList) },
    rampDistancePx: { median: median(distList), mean: mean(distList) },
    deathCauses,
  };

  console.log("\n--- Summary ---");
  console.log(JSON.stringify(summary, null, 2));

  const outPath = resolve(args.out || `results/${summary.policy}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await mkdir(join(outPath, ".."), { recursive: true });
  await writeFile(outPath, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nFull report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
