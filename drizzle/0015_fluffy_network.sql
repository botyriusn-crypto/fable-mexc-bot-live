CREATE UNIQUE INDEX IF NOT EXISTS "positions_unique_open" ON "positions" USING btree ("symbol","timeframe","strategy") WHERE "positions"."status" = 'open';
