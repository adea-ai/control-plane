CREATE TABLE "langgraph_legacy_drain_fences" (
	"storage_thread_id" varchar(256) PRIMARY KEY NOT NULL,
	"owner" varchar(256),
	"generation" bigint NOT NULL,
	"revision" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "langgraph_legacy_drain_fences_thread_check" CHECK (length("langgraph_legacy_drain_fences"."storage_thread_id") between 1 and 256),
	CONSTRAINT "langgraph_legacy_drain_fences_owner_check" CHECK ("langgraph_legacy_drain_fences"."owner" is null or length("langgraph_legacy_drain_fences"."owner") between 1 and 256),
	CONSTRAINT "langgraph_legacy_drain_fences_generation_check" CHECK ("langgraph_legacy_drain_fences"."generation" between 1 and 9007199254740991),
	CONSTRAINT "langgraph_legacy_drain_fences_revision_check" CHECK ("langgraph_legacy_drain_fences"."revision" between 1 and 9007199254740991)
);
