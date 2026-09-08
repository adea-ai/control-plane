CREATE TABLE "runtime_channel_ownership" (
	"node_id" varchar(30) PRIMARY KEY NOT NULL,
	"workspace_id" varchar(30) NOT NULL,
	"generation" bigint NOT NULL,
	"active" boolean NOT NULL,
	"record" jsonb NOT NULL
);
