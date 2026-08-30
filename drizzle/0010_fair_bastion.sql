ALTER TABLE "bot_config" ALTER COLUMN "sniper_min_stop_pct" SET DEFAULT 0.015;--> statement-breakpoint
ALTER TABLE "bot_config" ALTER COLUMN "sniper_tp_sl_ratio" SET DEFAULT 1.5;--> statement-breakpoint
ALTER TABLE "classifier_decisions" ADD COLUMN "return_unit" text;--> statement-breakpoint
ALTER TABLE "grid_configs" ADD COLUMN "session_started_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "classifier_decisions_strategy_created_at_idx" ON "classifier_decisions" USING btree ("strategy","created_at");