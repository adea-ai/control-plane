CREATE TABLE "hosted_graph_tool_configurations" (
	"tool_version_id" varchar(64) PRIMARY KEY NOT NULL,
	"schema_version" smallint NOT NULL,
	"tool_definition_id" varchar(64) NOT NULL,
	"content_digest" varchar(71) NOT NULL,
	"operation" varchar(128) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"cost_microunits" bigint NOT NULL,
	"configuration_digest" varchar(64) NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_graph_tool_configurations_schema_check" CHECK ("hosted_graph_tool_configurations"."schema_version" = 1),
	CONSTRAINT "hosted_graph_tool_configurations_price_check" CHECK ("hosted_graph_tool_configurations"."cost_microunits" > 0 and "hosted_graph_tool_configurations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "hosted_graph_tool_configurations_digest_check" CHECK ("hosted_graph_tool_configurations"."content_digest" ~ '^sha256:[a-f0-9]{64}$' and "hosted_graph_tool_configurations"."configuration_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tool_rate_limit_events" (
	"workspace_id" varchar(64) NOT NULL,
	"principal_ref" varchar(256) NOT NULL,
	"tool_definition_id" varchar(64) NOT NULL,
	"operation" varchar(128) NOT NULL,
	"tool_call_id" varchar(64) NOT NULL,
	"consumed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_rate_limit_events_workspace_id_tool_call_id_pk" PRIMARY KEY("workspace_id","tool_call_id"),
	CONSTRAINT "tool_rate_limit_events_identity_check" CHECK (length("tool_rate_limit_events"."principal_ref") > 0 and length("tool_rate_limit_events"."operation") > 0)
);
--> statement-breakpoint
CREATE INDEX "tool_rate_limit_events_window_index" ON "tool_rate_limit_events" USING btree ("workspace_id","principal_ref","tool_definition_id","operation","consumed_at");
--> statement-breakpoint
CREATE FUNCTION reject_hosted_graph_tool_configuration_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'HOSTED_GRAPH_TOOL_CONFIGURATION_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hosted_graph_tool_configurations_immutable
BEFORE UPDATE OR DELETE ON hosted_graph_tool_configurations
FOR EACH ROW EXECUTE FUNCTION reject_hosted_graph_tool_configuration_mutation();
