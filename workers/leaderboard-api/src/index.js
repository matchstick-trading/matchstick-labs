/**
 * Cloudflare Worker + D1 leaderboard API for matchstick-labs plays.
 *
 * Endpoints:
 * - GET  /api/scores?play=tape-and-ladder&limit=10  -> top N scores for a play
 * - POST /api/scores                                -> submit { play, initials, score }
 * - GET  /api/qualify?play=tape-and-ladder&score=X   -> does this score make the top N
 *
 * Bindings required:
 * - D1 database binding named: DB
 *
 * Env vars (Settings -> Variables):
 * - ALLOWED_ORIGINS: comma-separated origins allowed to call this API
 * - MAX_SCORE: max allowed score (default 100000000)
 * - MAX_INITIALS_LEN: default 4
 * - DEFAULT_LIMIT: default 10
 *
 * Anti-gaming posture (matches shooting-stars-forever's leaderboard, deliberately
 * lightweight for a fun demo, not a monetary-stakes system): a client can submit
 * any score under MAX_SCORE — there is no server-side replay/attestation of actual
 * gameplay. What this guards against is DB bloat and obviously absurd values, not a
 * determined cheater. Revisit if this leaderboard ever matters competitively.
 */

const DEFAULT_PLAY = "tape-and-ladder";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return new Response("Not found", { status: 404 });
    }

    if (request.method === "OPTIONS") {
      return withCors(env, request, new Response(null, { status: 204 }));
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/scores") {
        return withCors(env, request, await handleGetScores(env, url));
      }
      if (request.method === "POST" && url.pathname === "/api/scores") {
        return withCors(env, request, await handlePostScore(env, request));
      }
      if (request.method === "GET" && url.pathname === "/api/qualify") {
        return withCors(env, request, await handleQualify(env, url));
      }
      return withCors(env, request, new Response("Not found", { status: 404 }));
    } catch (err) {
      console.error("Worker error:", err);
      return withCors(env, request, json({ ok: false, error: "Server error" }, 500));
    }
  },
};

function getPlay(source) {
  const raw = typeof source.get === "function" ? source.get("play") : source.play;
  const cleaned = (raw || "").toString().trim().slice(0, 60);
  return cleaned || DEFAULT_PLAY;
}

async function handleGetScores(env, url) {
  const play = getPlay(url.searchParams);
  const defaultLimit = toInt(env.DEFAULT_LIMIT, 10);
  const limit = clamp(toInt(url.searchParams.get("limit"), defaultLimit), 1, 100);

  const stmt = env.DB.prepare(
    `SELECT initials, score, created_at
     FROM scores
     WHERE play = ?1
     ORDER BY score DESC, created_at ASC
     LIMIT ?2`
  ).bind(play, limit);

  const { results } = await stmt.all();

  const res = json({ ok: true, play, limit, scores: results }, 200);
  res.headers.set("Cache-Control", "public, max-age=10");
  return res;
}

async function handleQualify(env, url) {
  const play = getPlay(url.searchParams);
  const score = toInt(url.searchParams.get("score"), -1);
  if (!Number.isFinite(score) || score < 0) {
    return json({ ok: false, error: "Missing/invalid score" }, 400);
  }

  const limit = clamp(toInt(url.searchParams.get("limit"), toInt(env.DEFAULT_LIMIT, 10)), 1, 100);

  const stmt = env.DB.prepare(
    `SELECT score FROM scores
     WHERE play = ?1
     ORDER BY score DESC, created_at ASC
     LIMIT 1 OFFSET ?2`
  ).bind(play, limit - 1);

  const row = await stmt.first();

  if (!row) {
    return json({ ok: true, qualifies: true, cutoff: null, limit }, 200);
  }

  const cutoff = row.score;
  return json({ ok: true, qualifies: score > cutoff, cutoff, limit }, 200);
}

async function handlePostScore(env, request) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ua = request.headers.get("User-Agent") || "";
  const ipHash = await sha256Hex(ip);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const play = getPlay(body);
  const maxInitialsLen = toInt(env.MAX_INITIALS_LEN, 4);
  const maxScore = toInt(env.MAX_SCORE, 100000000);

  const initials = normalizeInitials(
    typeof body.initials === "string" ? body.initials : "",
    maxInitialsLen
  );
  const score = Number.isFinite(body.score) ? Math.floor(body.score) : NaN;

  if (!initials) return json({ ok: false, error: "Invalid initials" }, 400);
  if (!Number.isFinite(score) || score < 0 || score > maxScore) {
    return json({ ok: false, error: "Invalid score" }, 400);
  }

  const storeLimit = 50;
  const cutoffStmt = env.DB.prepare(
    `SELECT score FROM scores
     WHERE play = ?1
     ORDER BY score DESC, created_at ASC
     LIMIT 1 OFFSET ?2`
  ).bind(play, storeLimit - 1);

  const cutoffRow = await cutoffStmt.first();
  const qualifiesToStore = !cutoffRow || score > cutoffRow.score;
  if (!qualifiesToStore) {
    return json({ ok: true, stored: false, reason: "not_high_enough" }, 200);
  }

  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO scores (play, initials, score, created_at, ua, ip_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  ).bind(play, initials, score, now, ua.slice(0, 200), ipHash).run();

  // Trim each play's table to top 200 to keep it small forever.
  await env.DB.prepare(
    `DELETE FROM scores
     WHERE play = ?1 AND id NOT IN (
       SELECT id FROM scores WHERE play = ?1
       ORDER BY score DESC, created_at ASC
       LIMIT 200
     )`
  ).bind(play).run();

  return json({ ok: true, stored: true }, 200);
}

function withCors(env, request, response) {
  const origin = request.headers.get("Origin") || "";
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const allowOrigin = allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : "*";

  response.headers.set("Access-Control-Allow-Origin", allowOrigin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  response.headers.set("Access-Control-Max-Age", "86400");
  return response;
}

function parseAllowedOrigins(v) {
  if (!v || typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function toInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeInitials(s, maxLen) {
  const cleaned = (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, maxLen);
  return cleaned.length ? cleaned : "";
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
