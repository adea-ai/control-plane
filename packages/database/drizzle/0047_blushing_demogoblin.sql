CREATE TYPE "public"."catalog_approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TABLE "catalog_approvals" (
	"version_kind" varchar(16) NOT NULL,
	"version_id" varchar(64) NOT NULL,
	"revision" integer NOT NULL,
	"content_digest" varchar(71) NOT NULL,
	"decision" "catalog_approval_decision" NOT NULL,
	"actor_principal_ref" varchar(256) NOT NULL,
	"authority_ref" varchar(256),
	"rationale" varchar(1024),
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalog_approvals_version_kind_version_id_revision_pk" PRIMARY KEY("version_kind","version_id","revision")
);
--> statement-breakpoint
CREATE INDEX "catalog_approvals_version_index" ON "catalog_approvals" USING btree ("version_kind","version_id");