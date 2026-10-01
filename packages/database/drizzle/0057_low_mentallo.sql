CREATE TABLE "tool_calls" (
	"workspace_id" varchar(64) NOT NULL,
	"tool_call_id" varchar(64) NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"execution_id" varchar(64) NOT NULL,
	"revision" bigint NOT NULL,
	"call" jsonb NOT NULL,
	CONSTRAINT "tool_calls_workspace_id_tool_call_id_pk" PRIMARY KEY("workspace_id","tool_call_id"),
	CONSTRAINT "tool_calls_revision_check" CHECK ("tool_calls"."revision" > 0),
	CONSTRAINT "tool_calls_identity_check" CHECK (jsonb_typeof("tool_calls"."call") = 'object' and "tool_calls"."call"->>'toolCallId' = "tool_calls"."tool_call_id" and "tool_calls"."call"->>'workspaceId' = "tool_calls"."workspace_id" and "tool_calls"."call"->>'idempotencyKey' = "tool_calls"."idempotency_key" and "tool_calls"."call"->>'executionId' = "tool_calls"."execution_id" and ("tool_calls"."call"->>'revision')::bigint = "tool_calls"."revision")
);
--> statement-breakpoint
CREATE TABLE "tool_definitions" (
	"workspace_id" varchar(64) NOT NULL,
	"tool_definition_id" varchar(64) NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "tool_definitions_workspace_id_tool_definition_id_pk" PRIMARY KEY("workspace_id","tool_definition_id"),
	CONSTRAINT "tool_definitions_identity_check" CHECK (jsonb_typeof("tool_definitions"."definition") = 'object' and "tool_definitions"."definition"->>'toolDefinitionId' = "tool_definitions"."tool_definition_id")
);
--> statement-breakpoint
CREATE TABLE "tool_versions" (
	"workspace_id" varchar(64) NOT NULL,
	"tool_version_id" varchar(64) NOT NULL,
	"tool_definition_id" varchar(64) NOT NULL,
	"semantic_version" text NOT NULL,
	"version" jsonb NOT NULL,
	CONSTRAINT "tool_versions_workspace_id_tool_version_id_pk" PRIMARY KEY("workspace_id","tool_version_id"),
	CONSTRAINT "tool_versions_identity_check" CHECK (jsonb_typeof("tool_versions"."version") = 'object' and "tool_versions"."version"->>'toolVersionId' = "tool_versions"."tool_version_id" and "tool_versions"."version"->>'toolDefinitionId' = "tool_versions"."tool_definition_id" and "tool_versions"."version"->>'semanticVersion' = "tool_versions"."semantic_version")
);
--> statement-breakpoint
ALTER TABLE "tool_versions" ADD CONSTRAINT "tool_versions_definition_fk" FOREIGN KEY ("workspace_id","tool_definition_id") REFERENCES "public"."tool_definitions"("workspace_id","tool_definition_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tool_calls_workspace_idempotency_unique" ON "tool_calls" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "tool_calls_execution_index" ON "tool_calls" USING btree ("workspace_id","execution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_versions_semantic_version_unique" ON "tool_versions" USING btree ("workspace_id","tool_definition_id","semantic_version");--> statement-breakpoint
CREATE INDEX "tool_versions_definition_index" ON "tool_versions" USING btree ("workspace_id","tool_definition_id");