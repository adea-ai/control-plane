CREATE TABLE "workspace_catalog_commands" (
	"workspace_id" varchar(64) NOT NULL,
	"caller_id" varchar(64) NOT NULL,
	"operation" varchar(32) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_catalog_commands_scope_pk" PRIMARY KEY("workspace_id","caller_id","operation","idempotency_key"),
	CONSTRAINT "workspace_catalog_commands_operation_check" CHECK ("workspace_catalog_commands"."operation" in ('skill.publish', 'skill.deprecate', 'skill.revoke', 'profile.publish', 'profile.deprecate', 'profile.revoke')),
	CONSTRAINT "workspace_catalog_commands_payload_hash_check" CHECK ("workspace_catalog_commands"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "workspace_catalog_commands_receipt_object_check" CHECK (jsonb_typeof("workspace_catalog_commands"."receipt") = 'object' or "workspace_catalog_commands"."receipt" is null)
);
