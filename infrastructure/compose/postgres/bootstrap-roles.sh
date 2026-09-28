#!/bin/sh
set -eu

if [ -z "${PGPASSWORD:-}" ] || [ -z "${POSTGRES_MIGRATION_PASSWORD:-}" ] || [ -z "${POSTGRES_APPLICATION_PASSWORD:-}" ]; then
  echo 'PostgreSQL administrator, migration, and application passwords are required.' >&2
  exit 1
fi

case "${PGPASSWORD}${POSTGRES_MIGRATION_PASSWORD}${POSTGRES_APPLICATION_PASSWORD}" in
  *[!A-Za-z0-9._~-]*)
    echo 'PostgreSQL role passwords must be URL-safe.' >&2
    exit 1
    ;;
esac

if [ "$PGPASSWORD" = "$POSTGRES_MIGRATION_PASSWORD" ] ||
  [ "$PGPASSWORD" = "$POSTGRES_APPLICATION_PASSWORD" ] ||
  [ "$POSTGRES_MIGRATION_PASSWORD" = "$POSTGRES_APPLICATION_PASSWORD" ]; then
  echo 'PostgreSQL role passwords must be distinct.' >&2
  exit 1
fi

psql --set=ON_ERROR_STOP=1 --quiet <<SQL
SELECT 'CREATE ROLE control_plane_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_migrator') \gexec
SELECT 'CREATE ROLE control_plane_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_plane_app') \gexec

ALTER ROLE control_plane_migrator
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD '${POSTGRES_MIGRATION_PASSWORD}';
ALTER ROLE control_plane_app
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD '${POSTGRES_APPLICATION_PASSWORD}';

SELECT format(
  'ALTER TABLE %I.%I OWNER TO control_plane_migrator',
  namespace.nspname,
  relation.relname
)
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname IN ('public', 'drizzle')
  AND relation.relkind IN ('r', 'p', 'f')
  AND relation.relowner IN (
    SELECT oid FROM pg_roles WHERE rolname IN ('control_plane', 'control_plane_app')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend
    WHERE classid = 'pg_class'::regclass AND objid = relation.oid AND deptype = 'e'
  ) \gexec
SELECT format(
  'ALTER SEQUENCE %I.%I OWNER TO control_plane_migrator',
  namespace.nspname,
  relation.relname
)
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname IN ('public', 'drizzle')
  AND relation.relkind = 'S'
  AND relation.relowner IN (
    SELECT oid FROM pg_roles WHERE rolname IN ('control_plane', 'control_plane_app')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend
    WHERE classid = 'pg_class'::regclass AND objid = relation.oid AND deptype = 'e'
  ) \gexec
SELECT format(
  'ALTER %s %I.%I OWNER TO control_plane_migrator',
  CASE relation.relkind WHEN 'v' THEN 'VIEW' ELSE 'MATERIALIZED VIEW' END,
  namespace.nspname,
  relation.relname
)
FROM pg_class AS relation
JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname IN ('public', 'drizzle')
  AND relation.relkind IN ('v', 'm')
  AND relation.relowner IN (
    SELECT oid FROM pg_roles WHERE rolname IN ('control_plane', 'control_plane_app')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend
    WHERE classid = 'pg_class'::regclass AND objid = relation.oid AND deptype = 'e'
  ) \gexec
SELECT format(
  'ALTER ROUTINE %I.%I(%s) OWNER TO control_plane_migrator',
  namespace.nspname,
  procedure.proname,
  pg_get_function_identity_arguments(procedure.oid)
)
FROM pg_proc AS procedure
JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
WHERE namespace.nspname IN ('public', 'drizzle')
  AND procedure.proowner IN (
    SELECT oid FROM pg_roles WHERE rolname IN ('control_plane', 'control_plane_app')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend
    WHERE classid = 'pg_proc'::regclass AND objid = procedure.oid AND deptype = 'e'
  ) \gexec
SELECT format(
  'ALTER TYPE %I.%I OWNER TO control_plane_migrator',
  namespace.nspname,
  data_type.typname
)
FROM pg_type AS data_type
JOIN pg_namespace AS namespace ON namespace.oid = data_type.typnamespace
WHERE namespace.nspname IN ('public', 'drizzle')
  AND data_type.typtype <> 'd'
  AND data_type.typowner IN (
    SELECT oid FROM pg_roles WHERE rolname IN ('control_plane', 'control_plane_app')
  )
  AND data_type.typelem = 0
  AND (
    data_type.typrelid = 0
    OR EXISTS (
      SELECT 1
      FROM pg_class AS composite
      WHERE composite.oid = data_type.typrelid AND composite.relkind = 'c'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend
    WHERE classid = 'pg_type'::regclass AND objid = data_type.oid AND deptype = 'e'
  ) \gexec
SELECT format(
  'ALTER DOMAIN %I.%I OWNER TO control_plane_migrator',
  namespace.nspname,
  data_type.typname
)
FROM pg_type AS data_type
JOIN pg_namespace AS namespace ON namespace.oid = data_type.typnamespace
WHERE namespace.nspname IN ('public', 'drizzle')
  AND data_type.typtype = 'd'
  AND data_type.typowner IN (
    SELECT oid FROM pg_roles WHERE rolname IN ('control_plane', 'control_plane_app')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend
    WHERE classid = 'pg_type'::regclass AND objid = data_type.oid AND deptype = 'e'
  ) \gexec
SELECT format('ALTER SCHEMA %I OWNER TO control_plane_migrator', nspname)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle')
  AND nspowner IN (
    SELECT oid FROM pg_roles WHERE rolname IN ('control_plane', 'control_plane_app')
  ) \gexec
SELECT 'ALTER DATABASE control_plane OWNER TO control_plane_migrator'
FROM pg_database
WHERE datname = 'control_plane'
  AND datdba IN (
    SELECT oid FROM pg_roles WHERE rolname IN ('control_plane', 'control_plane_app')
  ) \gexec
SELECT format('REVOKE %I FROM control_plane_app', granted.rolname)
FROM pg_auth_members AS membership
JOIN pg_roles AS granted ON granted.oid = membership.roleid
JOIN pg_roles AS member ON member.oid = membership.member
WHERE member.rolname = 'control_plane_app' \gexec
REVOKE ALL PRIVILEGES ON DATABASE control_plane FROM control_plane_app;
SELECT format('REVOKE ALL PRIVILEGES ON SCHEMA %I FROM control_plane_app', nspname)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM control_plane_app', nspname)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle') \gexec
SELECT format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM control_plane_app', nspname)
FROM pg_namespace
WHERE nspname IN ('public', 'drizzle') \gexec
GRANT CONNECT, CREATE ON DATABASE control_plane TO control_plane_migrator;
GRANT CONNECT ON DATABASE control_plane TO control_plane_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO control_plane_migrator;
GRANT USAGE ON SCHEMA public TO control_plane_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO control_plane_app;
SELECT 'REVOKE ALL PRIVILEGES ON TABLE public.admission_rollout_gate FROM control_plane_app'
WHERE to_regclass('public.admission_rollout_gate') IS NOT NULL \gexec
SELECT 'GRANT SELECT ON TABLE public.admission_rollout_gate TO control_plane_app'
WHERE to_regclass('public.admission_rollout_gate') IS NOT NULL \gexec
SELECT 'REVOKE ALL PRIVILEGES ON TABLE public.retired_command_keys FROM control_plane_app'
WHERE to_regclass('public.retired_command_keys') IS NOT NULL \gexec
SELECT 'GRANT SELECT, INSERT ON TABLE public.retired_command_keys TO control_plane_app'
WHERE to_regclass('public.retired_command_keys') IS NOT NULL \gexec
SELECT 'REVOKE ALL PRIVILEGES ON TABLE public.runtime_node_verification_keys FROM control_plane_app'
WHERE to_regclass('public.runtime_node_verification_keys') IS NOT NULL \gexec
SELECT 'GRANT SELECT ON TABLE public.runtime_node_verification_keys TO control_plane_app'
WHERE to_regclass('public.runtime_node_verification_keys') IS NOT NULL \gexec
SELECT 'REVOKE ALL PRIVILEGES ON TABLE public.runtime_node_issued_credentials FROM control_plane_app'
WHERE to_regclass('public.runtime_node_issued_credentials') IS NOT NULL \gexec
SELECT 'GRANT SELECT ON TABLE public.runtime_node_issued_credentials TO control_plane_app'
WHERE to_regclass('public.runtime_node_issued_credentials') IS NOT NULL \gexec
SELECT 'GRANT UPDATE (consumed_at) ON TABLE public.runtime_node_issued_credentials TO control_plane_app'
WHERE to_regclass('public.runtime_node_issued_credentials') IS NOT NULL \gexec
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO control_plane_app;
ALTER DEFAULT PRIVILEGES FOR ROLE control_plane_migrator IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM control_plane_app;
ALTER DEFAULT PRIVILEGES FOR ROLE control_plane_migrator IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM control_plane_app;
ALTER DEFAULT PRIVILEGES FOR ROLE control_plane_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO control_plane_app;
ALTER DEFAULT PRIVILEGES FOR ROLE control_plane_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO control_plane_app;
SQL
