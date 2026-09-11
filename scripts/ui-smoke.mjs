#!/usr/bin/env node
// Run with: node scripts/ui-smoke.mjs [play-directory]
// Exercises real controls against an immutable local page snapshot. The game
// state hook is read-only; external requests, including score writes, are blocked.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { waitForHarness, getHarnessState } from "./lib/harness-util.mjs";

const playDir = resolve(process.argv[2] || "plays/tape-and-ladder");
const state = getHarnessState;

async function start(page) {
  await page.locator("#startBtn").click();
  await page.waitForFunction(() => window.__tapeAndLadder.getState().phase === "running");
  assert.equal(await page.locator("#setupCard").isVisible(), false);
}

function assertFrozen(before, after, message) {
  for (const key of ["cam", "playerX", "playerY", "rampDistancePx", "pnlTicks", "hwmTicks", "ladderIdx", "direction", "leverage"]) {
    assert.equal(after[key], before[key], `${message}: ${key} changed`);
  }
}

const cases = [
  ["setup waits without advancing the world", async (page) => {
    const before = await state(page);
    assert.equal(before.phase, "setup");
    assert.equal(before.cam, 0);
    assert.equal(await page.locator("#pauseBtn").isDisabled(), true);
    await page.waitForTimeout(250);
    assertFrozen(before, await state(page), "Setup must stay still while instructions are read");
  }],

  ["starting position matches either side of the ladder", async (page, url) => {
    for (const target of [{ direction: "SHORT", idx: 7 }, { direction: "LONG", idx: 8 }]) {
      await page.goto(`${url}?seed=1`, { waitUntil: "domcontentloaded" });
      const initial = await state(page);
      // Cross the spread in each direction, even when the seed starts on the
      // requested side. Setup moves have no live-run cooldown.
      const opposite = target.idx === 7 ? 8 : 7;
      let idx = initial.ladderIdx;
      for (const destination of [opposite, target.idx]) {
        while (idx !== destination) {
          await page.keyboard.press(idx < destination ? "w" : "s");
          idx += idx < destination ? 1 : -1;
        }
      }
      await start(page);
      const selected = await state(page);
      assert.equal(selected.ladderIdx, target.idx);
      assert.equal(selected.direction, target.direction);
      assert.equal(selected.leverage, 1);
    }
  }],

  ["R starts a fresh setup at the beginning of the world", async (page) => {
    const initial = await state(page);
    await start(page);
    // upcomingObstacles/upcomingHazards are always empty during setup (see
    // frame()'s gating), so comparing two setup-phase snapshots can never catch
    // a stale-stream regression; wait for a running-phase snapshot with a
    // populated stream instead, or the check below would pass vacuously.
    await page.waitForFunction(() => {
      const s = window.__tapeAndLadder.getState();
      return s.rampDistancePx > 150 && (s.upcomingObstacles.length > 0 || s.upcomingHazards.length > 0);
    }, null, { timeout: 8000 });
    const previous = await state(page);
    assert.ok(previous.cam > 0);
    await page.keyboard.press("r");
    const reset = await state(page);
    assert.equal(reset.phase, "setup");
    assert.equal(reset.cam, 0);
    assert.equal(reset.rampDistancePx, 0);
    assert.equal(reset.playerX, initial.playerX);
    assert.equal(reset.playerY, initial.playerY);
    assert.equal(reset.onGround, true);
    assert.equal(reset.pnlTicks, 0);
    assert.equal(reset.hwmTicks, 0);
    assert.equal(reset.leverage, 1);
    assert.equal(reset.scrollSpeed, initial.scrollSpeed);
    assert.equal(await page.locator("#setupCard").isVisible(), true);
    await page.waitForTimeout(150);
    assertFrozen(reset, await state(page), "Restarted setup must stay still");
    await start(page);
    assert.equal(await page.locator("#pauseBtn").isEnabled(), true);
    await page.waitForFunction(() => window.__tapeAndLadder.getState().rampDistancePx > 10);
    const restarted = await state(page);
    assert.ok(restarted.cam < previous.cam, "Restart must resume near the beginning, not the old camera position");
    // worldX/xStart are absolute world-space coordinates; a stale stream carried
    // over from the previous (far-advanced) run would sit at or beyond its old
    // camera position, not near the restarted run's much lower one.
    assert.ok(restarted.upcomingObstacles.every((obstacle) => obstacle.worldX < previous.cam),
      "Restart must discard the previous run's obstacle stream, not resume it mid-course");
    assert.ok(restarted.upcomingHazards.every((hazard) => hazard.xStart < previous.cam),
      "Restart must discard the previous run's hazard stream, not resume it mid-course");
  }],

  ["Space jumps during a run", async (page) => {
    await start(page);
    const groundY = (await state(page)).playerY;
    await page.keyboard.press("Space");
    await page.waitForFunction((ground) => {
      const current = window.__tapeAndLadder.getState();
      return !current.onGround && current.playerY < ground - 20;
    }, groundY);
    await page.waitForFunction(() => window.__tapeAndLadder.getState().onGround);
  }],

  ["a jump pressed shortly before landing is buffered", async (page) => {
    await start(page);
    const groundY = (await state(page)).playerY;
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction((ground) => window.__tapeAndLadder.getState().playerY < ground - 40, groundY);
    // On descent, 36px above ground is roughly 65ms from landing with the
    // current jump arc: inside the intended 110ms buffer, away from its edge.
    await page.waitForFunction((ground) => {
      const current = window.__tapeAndLadder.getState();
      return !current.onGround && current.playerY > ground - 36;
    }, groundY);
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction((ground) => window.__tapeAndLadder.getState().playerY < ground - 36, groundY, { timeout: 600 });
  }],

  ["an old airborne jump press expires before landing", async (page) => {
    await start(page);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(240);
    assert.equal((await state(page)).onGround, false);
    await page.keyboard.press("ArrowUp");
    await page.waitForFunction(() => window.__tapeAndLadder.getState().onGround);
    await page.waitForTimeout(150);
    assert.equal((await state(page)).onGround, true, "A press long before landing must not cause an automatic second jump");
  }],

  ["P and Resume pause the run and suppress gameplay inputs", async (page) => {
    await start(page);
    await page.waitForFunction(() => window.__tapeAndLadder.getState().rampDistancePx > 10);
    await page.keyboard.press("p");
    assert.equal(await page.locator("#pauseCard").isVisible(), true);
    const paused = await state(page);
    for (const key of ["w", "s", "ArrowUp"]) await page.keyboard.press(key);
    await page.waitForTimeout(150);
    assertFrozen(paused, await state(page), "Paused controls must not change the run");
    await page.keyboard.press("p");
    assert.equal(await page.locator("#pauseCard").isVisible(), false);
    await page.waitForFunction((cam) => window.__tapeAndLadder.getState().cam > cam, paused.cam);
    await page.locator("#pauseBtn").click();
    await page.locator("#resumeBtn").click();
    assert.equal(await page.locator("#pauseCard").isVisible(), false);
    // Space on a focused button should keep its native activation behavior.
    await page.keyboard.press("p");
    await page.keyboard.press("Space");
    assert.equal(await page.locator("#pauseCard").isVisible(), false);
    assert.equal((await state(page)).onGround, true, "Activating Resume must not also trigger a gameplay jump");
  }],

  ["window blur pauses and releases a held jump", async (page) => {
    await start(page);
    const groundY = (await state(page)).playerY;
    await page.keyboard.down("ArrowUp");
    await page.waitForFunction(() => !window.__tapeAndLadder.getState().onGround);
    // Headless tab activation is platform-dependent. Dispatch the browser
    // lifecycle event directly; gameplay still uses normal keyboard input.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    assert.equal(await page.locator("#pauseCard").isVisible(), true);
    const paused = await state(page);
    await page.waitForTimeout(150);
    assertFrozen(paused, await state(page), "Blur must pause the run");
    await page.locator("#resumeBtn").click();
    const peakY = await page.evaluate(() => new Promise((resolvePeak, rejectPeak) => {
      let peak = window.__tapeAndLadder.getState().playerY;
      const deadline = performance.now() + 1800;
      const sample = () => {
        const current = window.__tapeAndLadder.getState();
        peak = Math.min(peak, current.playerY);
        if (current.onGround || current.phase !== "running") resolvePeak(peak);
        else if (performance.now() > deadline) rejectPeak(new Error("Jump did not finish after resuming from blur"));
        else requestAnimationFrame(sample);
      };
      sample();
    }));
    await page.keyboard.up("ArrowUp");
    assert.ok(groundY - peakY < 145, `Held jump survived blur: peak height was ${Math.round(groundY - peakY)}px`);
    assert.ok(groundY - peakY > 70, "The original jump should resume rather than being grounded on blur");
  }],

  ["help blocks gameplay, contains focus, and returns focus on Escape", async (page) => {
    await start(page);
    await page.locator("#helpBtn").click();
    assert.equal(await page.locator("#helpOverlay").isVisible(), true);
    assert.equal(await page.locator("#helpOverlay").getAttribute("role"), "dialog");
    assert.equal(await page.locator("#helpOverlay").getAttribute("aria-modal"), "true");
    assert.equal(await page.locator("#helpBtn").getAttribute("aria-expanded"), "true");
    assert.equal(await page.evaluate(() => document.getElementById("helpOverlay").contains(document.activeElement)), true, "Opening help must move focus into the dialog");
    const frozen = await state(page);
    for (const key of ["w", "s", "ArrowUp", "r", "p"]) await page.keyboard.press(key);
    await page.waitForTimeout(150);
    assertFrozen(frozen, await state(page), "Help must block gameplay actions");
    for (const key of ["Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => document.getElementById("helpOverlay").contains(document.activeElement)), true, "Keyboard focus escaped the modal");
    }
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#helpOverlay").isVisible(), false);
    assert.equal(await page.locator("#helpBtn").getAttribute("aria-expanded"), "false");
    assert.equal(await page.evaluate(() => document.activeElement.id), "helpBtn");
    await page.keyboard.press("Space");
    assert.equal(await page.locator("#helpOverlay").isVisible(), true);
    await page.keyboard.press("Space");
    assert.equal(await page.locator("#helpOverlay").isVisible(), false, "Space should activate the focused Got it button");
  }],
];

async function main() {
  const html = await readFile(resolve(playDir, "index.html"));
  const server = createServer((req, res) => {
    if (req.method !== "GET" || new URL(req.url, "http://localhost").pathname !== "/") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const url = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  let failures = 0;
  try {
    browser = await chromium.launch({ headless: true });
    for (const [name, test] of cases) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, serviceWorkers: "block" });
      await context.route("**/*", (route) => {
        const request = route.request();
        return request.method() === "GET" && new URL(request.url()).origin === new URL(url).origin
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(3000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${url}?seed=1`, { waitUntil: "domcontentloaded" });
        await waitForHarness(page);
        await test(page, url);
        assert.deepEqual(errors, [], "Uncaught browser errors");
        console.log(`PASS ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}\n  ${error.message}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await new Promise((resolveClosed) => server.close(resolveClosed));
  }
  console.log(`\n${cases.length - failures}/${cases.length} interaction checks passed. External requests blocked.`);
  if (failures) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
