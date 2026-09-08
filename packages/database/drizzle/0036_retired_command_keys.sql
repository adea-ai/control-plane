CREATE TABLE "retired_command_keys" (
	"scope_key" varchar(64) PRIMARY KEY NOT NULL,
	"command_id" varchar(30) NOT NULL,
	"execution_id" varchar(30) NOT NULL,
	"retired_at" timestamp with time zone NOT NULL
);
