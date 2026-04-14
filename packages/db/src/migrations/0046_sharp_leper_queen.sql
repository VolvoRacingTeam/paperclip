CREATE TABLE "agent_budget_policies" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"workflow_name" text DEFAULT '*' NOT NULL,
	"primary_provider" text NOT NULL,
	"primary_model" text NOT NULL,
	"fallback_provider" text NOT NULL,
	"fallback_model" text NOT NULL,
	"max_tokens_per_run" integer NOT NULL,
	"daily_budget_tokens" integer NOT NULL,
	"timezone" text DEFAULT 'Europe/Oslo' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_daily_token_usage" (
	"agent_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"provider" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"last_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_daily_token_usage_pk" PRIMARY KEY("agent_id","usage_date","provider")
);
--> statement-breakpoint
CREATE TABLE "agent_run_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"workflow" text NOT NULL,
	"window_seconds" integer NOT NULL,
	"dedupe_window_bucket" bigint NOT NULL,
	"error_source" text NOT NULL,
	"error_class" text NOT NULL,
	"error_code" text,
	"http_status" integer,
	"target_ref" text,
	"normalized_message" text NOT NULL,
	"error_fingerprint" text NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_budget_policies" ADD CONSTRAINT "agent_budget_policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_daily_token_usage" ADD CONSTRAINT "agent_daily_token_usage_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_run_failures" ADD CONSTRAINT "agent_run_failures_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_failures_agent_workflow_fingerprint_bucket_uq" ON "agent_run_failures" USING btree ("agent_id","workflow","error_fingerprint","dedupe_window_bucket");
--> statement-breakpoint
CREATE INDEX "agent_run_failures_lookup_idx" ON "agent_run_failures" USING btree ("agent_id","workflow","last_seen_at");
