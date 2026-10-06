CREATE TABLE "project_state_initializations" (
	"workspace_id" varchar(30) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"caller_id" varchar(64) NOT NULL,
	"command_id" varchar(30) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"initialized_at" timestamp with time zone NOT NULL,
	CONSTRAINT "project_state_initializations_scope_pk" PRIMARY KEY("workspace_id","project_id"),
	CONSTRAINT "project_state_initializations_payload_hash_check" CHECK ("project_state_initializations"."payload_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "project_state_initializations" ADD CONSTRAINT "project_state_initializations_state_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."project_states"("workspace_id","project_id") ON DELETE no action ON UPDATE no action;