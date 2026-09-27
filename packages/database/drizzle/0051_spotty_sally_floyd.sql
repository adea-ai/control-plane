CREATE TABLE "usage_budget_states" (
	"execution_id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"parent_execution_id" varchar(30),
	"schema_version" integer NOT NULL,
	"state" jsonb NOT NULL,
	CONSTRAINT "usage_budget_states_schema_version_check" CHECK ("usage_budget_states"."schema_version" = 1),
	CONSTRAINT "usage_budget_states_state_object_check" CHECK (jsonb_typeof("usage_budget_states"."state") = 'object')
);
--> statement-breakpoint
CREATE TABLE "usage_operation_receipts" (
	"workspace_id" varchar(30) NOT NULL,
	"idempotency_key" varchar(256) NOT NULL,
	"execution_id" varchar(30) NOT NULL,
	"fingerprint" varchar(71) NOT NULL,
	"schema_version" integer NOT NULL,
	"receipt" jsonb NOT NULL,
	CONSTRAINT "usage_operation_receipts_workspace_key_pk" PRIMARY KEY("workspace_id","idempotency_key"),
	CONSTRAINT "usage_operation_receipts_schema_version_check" CHECK ("usage_operation_receipts"."schema_version" = 1),
	CONSTRAINT "usage_operation_receipts_receipt_object_check" CHECK (jsonb_typeof("usage_operation_receipts"."receipt") = 'object')
);
--> statement-breakpoint
ALTER TABLE "usage_ledger_entries" ALTER COLUMN "sequence" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "usage_budget_states" ADD CONSTRAINT "usage_budget_states_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_budget_states" ADD CONSTRAINT "usage_budget_states_parent_execution_id_executions_execution_id_fk" FOREIGN KEY ("parent_execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_operation_receipts" ADD CONSTRAINT "usage_operation_receipts_execution_id_executions_execution_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."executions"("execution_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_budget_states_workspace_execution_unique" ON "usage_budget_states" USING btree ("workspace_id","execution_id");--> statement-breakpoint
CREATE INDEX "usage_budget_states_workspace_parent_index" ON "usage_budget_states" USING btree ("workspace_id","parent_execution_id");--> statement-breakpoint
CREATE INDEX "usage_operation_receipts_workspace_execution_index" ON "usage_operation_receipts" USING btree ("workspace_id","execution_id");--> statement-breakpoint
CREATE INDEX "usage_operation_receipts_workspace_fingerprint_index" ON "usage_operation_receipts" USING btree ("workspace_id","fingerprint");