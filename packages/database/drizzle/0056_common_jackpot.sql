CREATE TABLE "graph_definition_commands" (
	"workspace_id" varchar(64) NOT NULL,
	"caller_id" varchar(64) NOT NULL,
	"operation" varchar(16) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_definition_commands_scope_pk" PRIMARY KEY("workspace_id","caller_id","operation","idempotency_key"),
	CONSTRAINT "graph_definition_commands_operation_check" CHECK ("graph_definition_commands"."operation" in ('publish', 'deprecate', 'revoke')),
	CONSTRAINT "graph_definition_commands_payload_hash_check" CHECK ("graph_definition_commands"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "graph_definition_commands_receipt_object_check" CHECK (jsonb_typeof("graph_definition_commands"."receipt") = 'object' or "graph_definition_commands"."receipt" is null)
);
