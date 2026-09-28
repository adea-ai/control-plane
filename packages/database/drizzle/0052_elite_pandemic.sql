CREATE TYPE "public"."admission_rollout_state" AS ENUM('open', 'paused');--> statement-breakpoint
CREATE TABLE "admission_rollout_gate" (
	"gate_key" varchar(32) PRIMARY KEY NOT NULL,
	"state" "admission_rollout_state" NOT NULL,
	"schema_version" integer NOT NULL,
	"revision" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" varchar(64) NOT NULL,
	CONSTRAINT "admission_rollout_gate_key_check" CHECK ("admission_rollout_gate"."gate_key" = 'intake'),
	CONSTRAINT "admission_rollout_gate_schema_version_check" CHECK ("admission_rollout_gate"."schema_version" = 1),
	CONSTRAINT "admission_rollout_gate_revision_check" CHECK ("admission_rollout_gate"."revision" between 0 and 9007199254740991)
);
--> statement-breakpoint
INSERT INTO "admission_rollout_gate" ("gate_key", "state", "schema_version", "revision", "updated_at", "updated_by")
SELECT
	'intake',
	CASE
		WHEN EXISTS (SELECT 1 FROM "executions")
			OR EXISTS (SELECT 1 FROM "execution_attempts")
			OR EXISTS (SELECT 1 FROM "command_inbox")
			OR EXISTS (SELECT 1 FROM "runtime_commands")
			OR EXISTS (SELECT 1 FROM "delegations")
		THEN 'paused'::"admission_rollout_state"
		ELSE 'open'::"admission_rollout_state"
	END,
	1,
	0,
	now(),
	current_user;
--> statement-breakpoint
DO $admission_rollout_privileges$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_app') THEN
		EXECUTE 'GRANT SELECT ON TABLE public.admission_rollout_gate TO control_plane_app';
		EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE public.admission_rollout_gate FROM control_plane_app';
	END IF;
END
$admission_rollout_privileges$;
