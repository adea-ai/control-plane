CREATE TABLE "checkpoint_blobs" (
	"thread_id" text NOT NULL,
	"checkpoint_ns" text DEFAULT '' NOT NULL,
	"channel" text NOT NULL,
	"version" text NOT NULL,
	"type" text NOT NULL,
	"blob" "bytea",
	CONSTRAINT "checkpoint_blobs_thread_id_checkpoint_ns_channel_version_pk" PRIMARY KEY("thread_id","checkpoint_ns","channel","version")
);
--> statement-breakpoint
CREATE TABLE "checkpoint_migrations" (
	"v" integer PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checkpoint_writes" (
	"thread_id" text NOT NULL,
	"checkpoint_ns" text DEFAULT '' NOT NULL,
	"checkpoint_id" text NOT NULL,
	"task_id" text NOT NULL,
	"idx" integer NOT NULL,
	"channel" text NOT NULL,
	"type" text,
	"blob" "bytea" NOT NULL,
	CONSTRAINT "checkpoint_writes_thread_id_checkpoint_ns_checkpoint_id_task_id_idx_pk" PRIMARY KEY("thread_id","checkpoint_ns","checkpoint_id","task_id","idx")
);
--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"thread_id" text NOT NULL,
	"checkpoint_ns" text DEFAULT '' NOT NULL,
	"checkpoint_id" text NOT NULL,
	"parent_checkpoint_id" text,
	"type" text,
	"checkpoint" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "checkpoints_thread_id_checkpoint_ns_checkpoint_id_pk" PRIMARY KEY("thread_id","checkpoint_ns","checkpoint_id")
);
--> statement-breakpoint
-- Keep the version marker aligned with langgraph-checkpoint-postgres 1.0.5's five migrations.
-- Hosted app processes verify this marker and never run the DDL setup path.
INSERT INTO "checkpoint_migrations" ("v") VALUES (0), (1), (2), (3), (4)
ON CONFLICT ("v") DO NOTHING;
