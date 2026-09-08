ALTER TABLE "outbox_events" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "quarantined_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "outbox_events_retry_index" ON "outbox_events" USING btree ("status","quarantined_at","next_attempt_at");