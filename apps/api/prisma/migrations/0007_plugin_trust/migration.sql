-- F3-s4: Add trust_score, content_checksum, votes_net to plugins table
-- trust_score: composite 0-100 signal from scan/smoke/reputation/votes (KV-weighted); null = unrated
-- content_checksum: sha256 of manifest.toml+plugin.py+hooks/*.py at install; recompute+WARN on update
-- votes_net: reserved community net-vote counter; inert (default 0 → neutral 50) until store→api sync
ALTER TABLE "plugins" ADD COLUMN "trust_score" REAL;
ALTER TABLE "plugins" ADD COLUMN "content_checksum" TEXT;
ALTER TABLE "plugins" ADD COLUMN "votes_net" INTEGER NOT NULL DEFAULT 0;
