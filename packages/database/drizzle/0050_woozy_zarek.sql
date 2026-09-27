CREATE TABLE "retention_holds" (
	"hold_id" varchar(36) PRIMARY KEY NOT NULL,
	"class_id" varchar(64) NOT NULL,
	"scope_kind" varchar(16) NOT NULL,
	"workspace_id" varchar(30),
	"project_id" varchar(30),
	"hold_owner" varchar(64) NOT NULL,
	"reason_code" varchar(64) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_principal_ref" varchar(256) NOT NULL,
	"created_authority_ref" varchar(256) NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"release_request_id" varchar(36),
	"released_at" timestamp with time zone,
	"released_by_principal_ref" varchar(256),
	"release_authority_ref" varchar(256),
	CONSTRAINT "retention_holds_scope_shape_check" CHECK (("retention_holds"."scope_kind" = 'class' and "retention_holds"."workspace_id" is null and "retention_holds"."project_id" is null) or ("retention_holds"."scope_kind" = 'workspace' and "retention_holds"."workspace_id" is not null and "retention_holds"."project_id" is null) or ("retention_holds"."scope_kind" = 'project' and "retention_holds"."workspace_id" is not null and "retention_holds"."project_id" is not null)),
	CONSTRAINT "retention_holds_release_revision_check" CHECK (("retention_holds"."revision" = 0 and "retention_holds"."release_request_id" is null and "retention_holds"."released_at" is null and "retention_holds"."released_by_principal_ref" is null and "retention_holds"."release_authority_ref" is null) or ("retention_holds"."revision" = 1 and "retention_holds"."release_request_id" is not null and "retention_holds"."released_at" is not null and "retention_holds"."released_by_principal_ref" is not null and "retention_holds"."release_authority_ref" is not null))
);
--> statement-breakpoint
CREATE INDEX "retention_holds_scope_index" ON "retention_holds" USING btree ("class_id","released_at","scope_kind","workspace_id","project_id");