#!/usr/bin/env node
//
// capture-clip.mjs — drive a play with a scripted input sequence and record
// a short video, for turning a play into social-media (LinkedIn) content.
//
// Usage: node scripts/capture-clip.mjs [play-dir] [out-dir]
//   play-dir defaults to plays/tape-and-ladder (must contain index.html)
//   out-dir  defaults to captures/<play-name>-<timestamp>/
//
// Self-contained like the vault's screenshot-import scripts: this file opens
// its own local server, drives the page with Playwright, and reports what it
// produced. It never edits the play's source.
//
// First pass — a working recording, not a polished production sequence. The
// key-timing below is hand-tuned by eye against this specific play's physics
// (see plays/tape-and-ladder/index.html: MOVE_SPEED/JUMP_V/GRAVITY); if a
// future play has different timing, this sequence won't transfer as-is.

import { chromium } from "playwright";
import { join, resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { serveDir } from "./lib/harness-util.mjs";

const PLAY_DIR = resolve(process.argv[2] || "plays/tape-and-ladder");
const PLAY_NAME = basename(PLAY_DIR);
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const OUT_DIR = resolve(process.argv[3] || `captures/${PLAY_NAME}-${STAMP}`);

async function main() {
  if (!existsSync(join(PLAY_DIR, "index.html"))) {
    console.error(`No index.html found in ${PLAY_DIR}`);
    process.exit(1);
  }

  const server = serveDir(PLAY_DIR);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  console.log(`Serving ${PLAY_DIR} at http://localhost:${port}`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1100, height: 720 },
    recordVideo: { dir: OUT_DIR, size: { width: 1100, height: 720 } },
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(400); // let the flicker/CRT intro settle before recording matters

  // Scripted sequence: run right, jump a gap, climb a few ladder rungs across
  // the spread, then let it idle a beat so the fanfare/sound tail is captured.
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(900);
  await page.keyboard.press("ArrowUp"); // jump mid-run
  await page.waitForTimeout(600);
  await page.keyboard.up("ArrowRight");
  await page.waitForTimeout(300);

  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("KeyW"); // climb toward and across the spread
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(800);

  await context.close();
  await browser.close();
  await new Promise((res) => server.close(res));

  console.log(`Capture complete. Video written under ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
