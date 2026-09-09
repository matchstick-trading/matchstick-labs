-- matchstick-labs leaderboard schema
-- Run with: npx wrangler d1 execute matchstick-labs-db --remote --file=./schema.sql
--
-- Shared across all plays/ games in this repo (score submission includes which
-- play it came from so the leaderboard can eventually be filtered per-game).

CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  play TEXT NOT NULL DEFAULT 'tape-and-ladder',
  initials TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  ua TEXT,
  ip_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_scores_play_score ON scores(play, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_created ON scores(created_at DESC);
