ALTER TABLE "grid_configs" RENAME COLUMN "session_started_at" TO "last_budget_fail_at";--> statement-breakpoint
DROP INDEX "classifier_decisions_strategy_created_at_idx";--> statement-breakpoint
ALTER TABLE "grid_configs" ADD COLUMN "last_setup_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grid_orders" ADD COLUMN "sl_price" double precision;