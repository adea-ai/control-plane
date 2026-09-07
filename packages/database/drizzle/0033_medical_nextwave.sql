CREATE TABLE "execution_validation_commands" (
	"command_key" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"project_id" varchar(30) NOT NULL,
	"execution_plan_id" varchar(30) NOT NULL,
	"record" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_validation_commands" ADD CONSTRAINT "execution_validation_commands_execution_plan_id_execution_plans_execution_plan_id_fk" FOREIGN KEY ("execution_plan_id") REFERENCES "public"."execution_plans"("execution_plan_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_validation_commands_scope_index" ON "execution_validation_commands" USING btree ("workspace_id","project_id");