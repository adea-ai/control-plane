CREATE TABLE "model_selection_records" (
	"workspace_id" varchar(30) NOT NULL,
	"kind" varchar(16) NOT NULL,
	"ref" varchar(64) NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "model_selection_records_workspace_id_kind_ref_pk" PRIMARY KEY("workspace_id","kind","ref")
);
