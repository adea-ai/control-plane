CREATE TABLE "runtime_node_issued_credentials" (
	"credential_id" varchar(128) PRIMARY KEY NOT NULL,
	"node_id" varchar(30) NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"key_id" varchar(128) NOT NULL,
	"claims" jsonb NOT NULL,
	"revocation_version" bigint NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "runtime_node_issued_credentials_version_check" CHECK ("runtime_node_issued_credentials"."revocation_version" between 1 and 9007199254740991),
	CONSTRAINT "runtime_node_issued_credentials_expiry_check" CHECK ("runtime_node_issued_credentials"."expires_at" > "runtime_node_issued_credentials"."issued_at"),
	CONSTRAINT "runtime_node_issued_credentials_claims_scope_check" CHECK (jsonb_typeof("runtime_node_issued_credentials"."claims") = 'object'
        and "runtime_node_issued_credentials"."claims" ->> 'credentialKind' = 'runtime_node'
        and ("runtime_node_issued_credentials"."claims" ->> 'schemaVersion')::integer = 1
        and "runtime_node_issued_credentials"."claims" ->> 'credentialId' = "runtime_node_issued_credentials"."credential_id"
        and "runtime_node_issued_credentials"."claims" ->> 'nodeId' = "runtime_node_issued_credentials"."node_id"
        and "runtime_node_issued_credentials"."claims" ->> 'workspaceId' = "runtime_node_issued_credentials"."workspace_id"
        and "runtime_node_issued_credentials"."claims" ->> 'keyId' = "runtime_node_issued_credentials"."key_id"),
	CONSTRAINT "runtime_node_issued_credentials_revocation_state_check" CHECK (("runtime_node_issued_credentials"."revoked_at" is null
          and "runtime_node_issued_credentials"."revocation_version" = ("runtime_node_issued_credentials"."claims" ->> 'revocationVersion')::bigint)
        or ("runtime_node_issued_credentials"."revoked_at" is not null
          and "runtime_node_issued_credentials"."revocation_version" = ("runtime_node_issued_credentials"."claims" ->> 'revocationVersion')::bigint + 1))
);
--> statement-breakpoint
CREATE TABLE "runtime_node_verification_keys" (
	"key_id" varchar(128) PRIMARY KEY NOT NULL,
	"node_id" varchar(30) NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"public_key_pem" varchar(2048) NOT NULL,
	"thumbprint" varchar(71) NOT NULL,
	"status" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_node_verification_keys_status_check" CHECK ("runtime_node_verification_keys"."status" in ('active', 'retired', 'revoked')),
	CONSTRAINT "runtime_node_verification_keys_thumbprint_check" CHECK ("runtime_node_verification_keys"."thumbprint" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "runtime_node_verification_keys_public_key_check" CHECK ("runtime_node_verification_keys"."public_key_pem" like '-----BEGIN PUBLIC KEY-----%-----END PUBLIC KEY-----%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_node_verification_keys_scope_unique" ON "runtime_node_verification_keys" USING btree ("key_id","node_id","workspace_id");--> statement-breakpoint
ALTER TABLE "runtime_node_issued_credentials" ADD CONSTRAINT "runtime_node_issued_credentials_key_scope_fk" FOREIGN KEY ("key_id","node_id","workspace_id") REFERENCES "public"."runtime_node_verification_keys"("key_id","node_id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_node_issued_credentials_key_scope_idx" ON "runtime_node_issued_credentials" USING btree ("key_id","node_id","workspace_id");--> statement-breakpoint
DO $runtime_node_identity_privileges$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_app') THEN
		EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.runtime_node_verification_keys FROM control_plane_app';
		EXECUTE 'GRANT SELECT ON TABLE public.runtime_node_verification_keys TO control_plane_app';
		EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.runtime_node_issued_credentials FROM control_plane_app';
		EXECUTE 'GRANT SELECT ON TABLE public.runtime_node_issued_credentials TO control_plane_app';
		EXECUTE 'GRANT UPDATE (consumed_at) ON TABLE public.runtime_node_issued_credentials TO control_plane_app';
	END IF;
END
$runtime_node_identity_privileges$;
--> statement-breakpoint
CREATE FUNCTION public.lock_runtime_node_credential_for_write(
	p_credential_id varchar,
	p_revocation_version bigint,
	p_node_id varchar,
	p_workspace_id varchar
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $runtime_node_inventory_credential_lock$
DECLARE
	actual_node_id varchar;
	actual_workspace_id varchar;
	actual_revocation_version bigint;
	actual_consumed_at timestamp with time zone;
	actual_revoked_at timestamp with time zone;
	actual_expires_at timestamp with time zone;
	actual_key_node_id varchar;
	actual_key_workspace_id varchar;
	actual_key_status varchar;
BEGIN
	SELECT
		credential.node_id,
		credential.workspace_id,
		credential.revocation_version,
		credential.consumed_at,
		credential.revoked_at,
		credential.expires_at,
		verification_key.node_id,
		verification_key.workspace_id,
		verification_key.status
	INTO
		actual_node_id,
		actual_workspace_id,
		actual_revocation_version,
		actual_consumed_at,
		actual_revoked_at,
		actual_expires_at,
		actual_key_node_id,
		actual_key_workspace_id,
		actual_key_status
	FROM public.runtime_node_issued_credentials AS credential
	INNER JOIN public.runtime_node_verification_keys AS verification_key
		ON verification_key.key_id = credential.key_id
		AND verification_key.node_id = credential.node_id
		AND verification_key.workspace_id = credential.workspace_id
	WHERE credential.credential_id = p_credential_id
	FOR SHARE OF credential, verification_key;
	IF NOT FOUND THEN
		RETURN FALSE;
	END IF;
	RETURN COALESCE(
		actual_revocation_version = p_revocation_version
			AND actual_node_id = p_node_id
			AND actual_workspace_id = p_workspace_id
			AND actual_consumed_at IS NOT NULL
			AND actual_revoked_at IS NULL
			AND actual_expires_at > clock_timestamp()
			AND actual_key_node_id = p_node_id
			AND actual_key_workspace_id = p_workspace_id
			AND actual_key_status = 'active',
		FALSE
	);
END
$runtime_node_inventory_credential_lock$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lock_runtime_node_credential_for_write(varchar, bigint, varchar, varchar) FROM PUBLIC;
--> statement-breakpoint
DO $runtime_node_inventory_credential_lock_privileges$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_app') THEN
		EXECUTE 'GRANT EXECUTE ON FUNCTION public.lock_runtime_node_credential_for_write(varchar, bigint, varchar, varchar) TO control_plane_app';
	END IF;
END
$runtime_node_inventory_credential_lock_privileges$;
--> statement-breakpoint
CREATE FUNCTION public.prevent_runtime_node_credential_consumption_reuse()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $runtime_node_credential_consumption_once$
BEGIN
	IF OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'runtime_node_credential_consumption_immutable';
	END IF;
	RETURN NEW;
END
$runtime_node_credential_consumption_once$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_runtime_node_credential_consumption_reuse() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER runtime_node_issued_credentials_consumption_once
BEFORE UPDATE OF consumed_at ON public.runtime_node_issued_credentials
FOR EACH ROW EXECUTE FUNCTION public.prevent_runtime_node_credential_consumption_reuse();
