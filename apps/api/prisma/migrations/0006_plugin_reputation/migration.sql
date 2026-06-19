-- F3-s3: Add reputation_score and reputation_detail to plugins table
-- reputation_score: composite 0-100 trust signal from gate-ready pretest portfolios; null = unrated
-- reputation_detail: JSON sample shape for provenance display; null = unrated
ALTER TABLE "plugins" ADD COLUMN "reputation_score" REAL;
ALTER TABLE "plugins" ADD COLUMN "reputation_detail" TEXT;
