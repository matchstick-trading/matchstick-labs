// harness-util.mjs — small pieces shared by the Playwright-driven scripts that
// exercise a play's window.__tapeAndLadder-style debug API: a static file
// server for a play directory, and the ready-wait/getState accessors used to
// talk to the debug hook. Kept intentionally tiny so autoplay-eval.mjs,
// capture-clip.mjs, and ui-smoke.mjs each stay otherwise self-contained.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

export function serveDir(dir) {
  const root = resolve(dir);
  return createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(req.url.split("?")[0]);
    } catch {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    const filePath = path === "/" ? join(root, "index.html") : resolve(root, `.${path}`);
    // Only files inside the served directory: a path that climbs out of it gets a 404.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    try {
      const data = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
}

// `timeout` is left undefined by default so callers that rely on a page-level
// page.setDefaultTimeout() aren't overridden; pass one explicitly to set it here.
export async function waitForHarness(page, timeout) {
  await page.waitForFunction(() => !!window.__tapeAndLadder, null, timeout == null ? undefined : { timeout });
}

export function getHarnessState(page) {
  return page.evaluate(() => window.__tapeAndLadder.getState());
}
