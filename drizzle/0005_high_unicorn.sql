CREATE TABLE "advisor_variants" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"params" jsonb NOT NULL,
	"stats" jsonb DEFAULT '{"allowed":0,"correct":0,"sumReturn":0}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "advisor_variants_name_unique" UNIQUE("name")
);
