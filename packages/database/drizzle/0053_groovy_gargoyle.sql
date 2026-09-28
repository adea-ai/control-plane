ALTER TABLE "retired_command_keys" ADD COLUMN "metadata_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "retired_command_keys" ADD COLUMN "identity_digest" varchar(64);--> statement-breakpoint
CREATE INDEX "retired_command_keys_retired_at_index" ON "retired_command_keys" USING btree ("retired_at");--> statement-breakpoint
ALTER TABLE "retired_command_keys" ADD CONSTRAINT "retired_command_keys_metadata_check" CHECK (("retired_command_keys"."metadata_version" = 1 and "retired_command_keys"."identity_digest" is null) or ("retired_command_keys"."metadata_version" = 2 and "retired_command_keys"."identity_digest" is not null and "retired_command_keys"."identity_digest" ~ '^[a-f0-9]{64}$'));--> statement-breakpoint
DO $retired_command_key_privileges$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_app') THEN
		EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.retired_command_keys FROM control_plane_app';
		EXECUTE 'GRANT SELECT, INSERT ON TABLE public.retired_command_keys TO control_plane_app';
	END IF;
END
$retired_command_key_privileges$;
