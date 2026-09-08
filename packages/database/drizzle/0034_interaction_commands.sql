CREATE TABLE "interaction_commands" (
	"command_key" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "interaction_commands_scope_index" ON "interaction_commands" USING btree ("workspace_id","project_id");