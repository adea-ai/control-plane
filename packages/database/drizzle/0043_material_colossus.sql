CREATE TABLE "context_command_grants" (
	"workspace_id" varchar(30) NOT NULL,
	"authorization_ref" varchar(128) NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "context_command_grants_workspace_id_authorization_ref_pk" PRIMARY KEY("workspace_id","authorization_ref")
);
