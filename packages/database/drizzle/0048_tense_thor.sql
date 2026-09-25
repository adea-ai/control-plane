CREATE TABLE "retired_execution_event_ids" (
	"event_id" varchar(30) PRIMARY KEY NOT NULL,
	"execution_id" varchar(30) NOT NULL,
	"sequence" integer NOT NULL,
	"retired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "retired_execution_event_ids_execution_index" ON "retired_execution_event_ids" USING btree ("execution_id","sequence");