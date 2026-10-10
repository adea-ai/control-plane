CREATE TABLE "persistence_records" (
	"namespace" varchar(128) NOT NULL,
	"id" varchar(512) NOT NULL,
	"revision" integer NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "persistence_records_scope_pk" PRIMARY KEY("namespace","id")
);
