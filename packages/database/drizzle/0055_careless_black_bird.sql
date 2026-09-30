CREATE TABLE "graph_definition_versions" (
	"workspace_id" varchar(64) NOT NULL,
	"graph_definition_id" varchar(256) NOT NULL,
	"graph_version" text NOT NULL,
	"revision" bigint NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "graph_definition_versions_workspace_id_graph_definition_id_graph_version_pk" PRIMARY KEY("workspace_id","graph_definition_id","graph_version")
);
