ALTER TYPE "public"."usage_ledger_entry_kind" ADD VALUE 'model_reservation' BEFORE 'model_usage';--> statement-breakpoint
ALTER TYPE "public"."usage_ledger_entry_kind" ADD VALUE 'model_release' BEFORE 'model_usage';--> statement-breakpoint
ALTER TABLE "usage_ledger_entries" ADD COLUMN "model_call_id" varchar(30);--> statement-breakpoint
ALTER TABLE "usage_ledger_entries" ADD COLUMN "reserved_tokens" bigint;--> statement-breakpoint
ALTER TABLE "usage_ledger_entries" ADD COLUMN "price_snapshot_digest" varchar(71);--> statement-breakpoint
ALTER TABLE "usage_ledger_entries" ADD COLUMN "request_digest" varchar(71);