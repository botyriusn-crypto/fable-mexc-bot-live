CREATE TABLE "grid_flow_shadow" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"side" text NOT NULL,
	"entry_price" double precision NOT NULL,
	"quantity" double precision DEFAULT 1 NOT NULL,
	"leverage" integer DEFAULT 2 NOT NULL,
	"tp_price" double precision,
	"sl_price" double precision,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_pnl" double precision,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "grid_flow_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"timeframe" text DEFAULT 'Min15' NOT NULL,
	"gate_enabled" boolean DEFAULT true NOT NULL,
	"window_ms" integer DEFAULT 21600000 NOT NULL,
	"kill_switch_window_ms" integer DEFAULT 86400000 NOT NULL,
	"last_eval_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_flow_state_symbol_unique" UNIQUE("symbol")
);
