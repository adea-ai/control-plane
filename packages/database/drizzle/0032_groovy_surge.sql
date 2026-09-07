CREATE TABLE "context_authoring_commands" (
	"command_key" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"context_package_id" varchar(30) NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_authoring_commands" ADD CONSTRAINT "context_authoring_commands_context_package_id_context_packages_context_package_id_fk" FOREIGN KEY ("context_package_id") REFERENCES "public"."context_packages"("context_package_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_authoring_commands_scope_index" ON "context_authoring_commands" USING btree ("workspace_id","project_id");