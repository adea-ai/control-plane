CREATE TABLE "runtime_channel_sequences" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"identity" text NOT NULL,
	"next" bigint NOT NULL,
	CONSTRAINT "runtime_channel_sequences_next_bounds" CHECK ("runtime_channel_sequences"."next" between 1 and 2147483648)
);
