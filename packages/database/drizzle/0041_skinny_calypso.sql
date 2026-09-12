CREATE TABLE "context_commands" (
	"command_id" varchar(30) PRIMARY KEY NOT NULL,
	"operation_key" varchar(71) NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"node_id" varchar(30) NOT NULL,
	"version" integer NOT NULL,
	"status" varchar(16) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "context_commands_operation_key_unique" ON "context_commands" USING btree ("operation_key");--> statement-breakpoint
CREATE INDEX "context_commands_dispatch_index" ON "context_commands" USING btree ("workspace_id","node_id","status","issued_at","command_id");