CREATE TABLE "context_provider_registrations" (
	"workspace_id" varchar(30) NOT NULL,
	"connection_id" varchar(30) NOT NULL,
	"principal_ref" varchar(256) NOT NULL,
	"state" varchar(16) NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "context_provider_registrations_workspace_id_connection_id_pk" PRIMARY KEY("workspace_id","connection_id")
);
--> statement-breakpoint
CREATE INDEX "context_provider_registrations_scope_idx" ON "context_provider_registrations" USING btree ("workspace_id","principal_ref","state");