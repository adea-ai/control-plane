CREATE TABLE "credential_audit_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"action" varchar(32) NOT NULL,
	"credential_id" varchar(64) NOT NULL,
	"credential_lease_id" varchar(64),
	"workspace_id" varchar(64) NOT NULL,
	"revision" bigint NOT NULL,
	"principal_ref" varchar(256),
	"reason_code" varchar(128),
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "credential_audit_events_reason_code_check" CHECK ("credential_audit_events"."reason_code" is null or "credential_audit_events"."reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "credential_commands" (
	"workspace_id" varchar(64) NOT NULL,
	"caller_id" varchar(256) NOT NULL,
	"operation" varchar(16) NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_commands_scope_pk" PRIMARY KEY("workspace_id","caller_id","operation","idempotency_key"),
	CONSTRAINT "credential_commands_operation_check" CHECK ("credential_commands"."operation" in ('create', 'rotate')),
	CONSTRAINT "credential_commands_payload_hash_check" CHECK ("credential_commands"."payload_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "credential_commands_result_object_check" CHECK (jsonb_typeof("credential_commands"."result") = 'object')
);
--> statement-breakpoint
CREATE TABLE "credential_leases" (
	"credential_lease_id" varchar(64) PRIMARY KEY NOT NULL,
	"capability_ref" varchar(160) NOT NULL,
	"credential_id" varchar(64) NOT NULL,
	"credential_revision" bigint NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"principal_ref" varchar(256) NOT NULL,
	"operation" varchar(256) NOT NULL,
	"resource_ref" varchar(256) NOT NULL,
	"status" varchar(16) NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"policy_decision_id" varchar(71) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "credential_leases_status_check" CHECK ("credential_leases"."status" in ('active', 'consumed', 'expired', 'revoked')),
	CONSTRAINT "credential_leases_lifetime_check" CHECK ("credential_leases"."expires_at" > "credential_leases"."issued_at" and "credential_leases"."expires_at" <= "credential_leases"."issued_at" + interval '300 seconds'),
	CONSTRAINT "credential_leases_revision_check" CHECK ("credential_leases"."credential_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"credential_id" varchar(64) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(64) NOT NULL,
	"connector_ref" varchar(256) NOT NULL,
	"provider" varchar(128) NOT NULL,
	"status" varchar(32) NOT NULL,
	"revision" bigint NOT NULL,
	"created_by" varchar(256),
	"created_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"secret_revisions" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credentials_status_check" CHECK ("credentials"."status" in ('active', 'revoked', 'secret_required')),
	CONSTRAINT "credentials_revision_check" CHECK ("credentials"."revision" > 0),
	CONSTRAINT "credentials_secret_revisions_array_check" CHECK (jsonb_typeof("credentials"."secret_revisions") = 'array'),
	CONSTRAINT "credentials_revoked_at_check" CHECK (("credentials"."status" = 'revoked') = ("credentials"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "credential_leases" ADD CONSTRAINT "credential_leases_credential_id_credentials_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("credential_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_audit_events_workspace_index" ON "credential_audit_events" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "credential_audit_events_credential_index" ON "credential_audit_events" USING btree ("credential_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_leases_capability_unique" ON "credential_leases" USING btree ("capability_ref");--> statement-breakpoint
CREATE INDEX "credential_leases_credential_status_index" ON "credential_leases" USING btree ("credential_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_workspace_connector_live_unique" ON "credentials" USING btree ("workspace_id","connector_ref") WHERE "credentials"."status" <> 'revoked';--> statement-breakpoint
CREATE INDEX "credentials_workspace_index" ON "credentials" USING btree ("workspace_id","credential_id");--> statement-breakpoint
CREATE FUNCTION reject_credential_audit_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CREDENTIAL_AUDIT_EVENT_IMMUTABLE';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER credential_audit_events_append_only
BEFORE UPDATE OR DELETE ON credential_audit_events
FOR EACH ROW EXECUTE FUNCTION reject_credential_audit_event_mutation();
