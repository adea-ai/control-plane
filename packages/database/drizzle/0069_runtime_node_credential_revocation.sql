CREATE TABLE "runtime_node_credential_audit_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"action" varchar(32) NOT NULL,
	"outcome" varchar(32) NOT NULL,
	"credential_id" varchar(128) NOT NULL,
	"node_id" varchar(30),
	"workspace_id" varchar(30) NOT NULL,
	"revocation_version" bigint,
	"principal_ref" varchar(256) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_node_credential_audit_events_action_check" CHECK ("runtime_node_credential_audit_events"."action" = 'revoke'),
	CONSTRAINT "runtime_node_credential_audit_events_outcome_check" CHECK ("runtime_node_credential_audit_events"."outcome" in ('applied', 'replayed', 'workspace_refused'))
);
--> statement-breakpoint
CREATE INDEX "runtime_node_credential_audit_events_workspace_index" ON "runtime_node_credential_audit_events" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "runtime_node_credential_audit_events_credential_index" ON "runtime_node_credential_audit_events" USING btree ("credential_id","sequence");
--> statement-breakpoint
CREATE FUNCTION public.reject_runtime_node_credential_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $runtime_node_credential_audit_immutable$
BEGIN
	RAISE EXCEPTION 'RUNTIME_NODE_CREDENTIAL_AUDIT_IMMUTABLE';
END
$runtime_node_credential_audit_immutable$;
--> statement-breakpoint
CREATE TRIGGER runtime_node_credential_audit_events_append_only
BEFORE UPDATE OR DELETE ON public.runtime_node_credential_audit_events
FOR EACH ROW EXECUTE FUNCTION public.reject_runtime_node_credential_audit_mutation();
--> statement-breakpoint
-- The only write path for hosted revocation. SECURITY DEFINER runs as the migration owner, so the
-- application role needs EXECUTE on this function and no table write privilege. The function is
-- workspace-bound, idempotent, and records every applied, replayed, or workspace-refused outcome.
-- Unknown credential identifiers return not_found without an audit row, so callers cannot flood it.
CREATE FUNCTION public.revoke_runtime_node_credential(
	p_credential_id varchar,
	p_workspace_id varchar,
	p_principal_ref varchar,
	p_now timestamp with time zone
)
RETURNS TABLE (result_outcome varchar, result_credential_id varchar)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $runtime_node_credential_revocation$
DECLARE
	target public.runtime_node_issued_credentials%ROWTYPE;
	actor varchar;
BEGIN
	actor := COALESCE(NULLIF(p_principal_ref, ''), session_user);
	SELECT * INTO target
	FROM public.runtime_node_issued_credentials AS credential
	WHERE credential.credential_id = p_credential_id
	FOR UPDATE;
	IF NOT FOUND THEN
		RETURN QUERY SELECT 'not_found'::varchar, p_credential_id;
		RETURN;
	END IF;
	IF target.workspace_id IS DISTINCT FROM p_workspace_id THEN
		INSERT INTO public.runtime_node_credential_audit_events (
			action, outcome, credential_id, node_id, workspace_id, revocation_version, principal_ref, at
		) VALUES (
			'revoke', 'workspace_refused', p_credential_id, NULL, p_workspace_id, NULL, actor, transaction_timestamp()
		);
		RETURN QUERY SELECT 'workspace_refused'::varchar, p_credential_id;
		RETURN;
	END IF;
	IF target.revoked_at IS NOT NULL THEN
		INSERT INTO public.runtime_node_credential_audit_events (
			action, outcome, credential_id, node_id, workspace_id, revocation_version, principal_ref, at
		) VALUES (
			'revoke', 'replayed', target.credential_id, target.node_id, target.workspace_id, target.revocation_version, actor, transaction_timestamp()
		);
		RETURN QUERY SELECT 'replayed'::varchar, p_credential_id;
		RETURN;
	END IF;
	IF target.revocation_version >= 9007199254740991 THEN
		RAISE EXCEPTION 'RUNTIME_NODE_IDENTITY_VERSION_EXHAUSTED';
	END IF;
	UPDATE public.runtime_node_issued_credentials AS credential
	SET revocation_version = target.revocation_version + 1,
		revoked_at = p_now
	WHERE credential.credential_id = p_credential_id;
	INSERT INTO public.runtime_node_credential_audit_events (
		action, outcome, credential_id, node_id, workspace_id, revocation_version, principal_ref, at
	) VALUES (
		'revoke', 'applied', target.credential_id, target.node_id, target.workspace_id, target.revocation_version + 1, actor, transaction_timestamp()
	);
	PERFORM pg_notify('runtime_node_credential_revocations_v1', p_credential_id);
	RETURN QUERY SELECT 'applied'::varchar, p_credential_id;
END
$runtime_node_credential_revocation$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.revoke_runtime_node_credential(varchar, varchar, varchar, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE public.runtime_node_credential_audit_events FROM PUBLIC;
--> statement-breakpoint
DO $runtime_node_credential_revocation_privileges$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_app') THEN
		EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.runtime_node_credential_audit_events FROM control_plane_app';
		EXECUTE 'GRANT EXECUTE ON FUNCTION public.revoke_runtime_node_credential(varchar, varchar, varchar, timestamp with time zone) TO control_plane_app';
	END IF;
END
$runtime_node_credential_revocation_privileges$;
