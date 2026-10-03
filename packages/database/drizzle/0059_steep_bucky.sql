CREATE TABLE "graph_tool_cancellations" (
	"workspace_id" varchar(64) NOT NULL,
	"execution_id" varchar(64) NOT NULL,
	"thread_id" varchar(256) NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_tool_cancellations_workspace_id_execution_id_pk" PRIMARY KEY("workspace_id","execution_id"),
	CONSTRAINT "graph_tool_cancellations_key_check" CHECK (length("graph_tool_cancellations"."idempotency_key") > 0 and length("graph_tool_cancellations"."thread_id") > 0)
);
