#!/usr/bin/env bash
set -euo pipefail

[[ "${RUNNER_TEMP:-}" == /* && -d "$RUNNER_TEMP" ]] || { echo 'Absolute existing RUNNER_TEMP required.' >&2; exit 2; }
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || { echo 'Numeric run identity required.' >&2; exit 2; }
compose_root=''
compose_project=''
compose_started=false

compose() {
  timeout --signal=TERM --kill-after=5s 180s docker compose --project-name "$compose_project" "$@"
}

cleanup() {
  local exit_code="$?" cleanup_code=0
  trap - EXIT HUP INT TERM
  set +e
  if [[ "$compose_started" == true ]]; then
    if [[ "$exit_code" != 0 ]]; then
      compose --profile simple --profile server ps -a || true
      compose --profile simple --profile server logs --no-color || true
    fi
    compose --profile simple --profile server down --volumes --remove-orphans --timeout 60
    cleanup_code="$?"
  fi
  if [[ "$cleanup_code" == 0 && -n "$compose_root" ]]; then
    timeout --signal=TERM --kill-after=5s 20s sudo "$node_bin" ../../scripts/remove-hosted-compose-fixture.mjs "$RUNNER_TEMP" "$compose_root" "$compose_project"
    cleanup_code="$?"
  fi
  if [[ "$cleanup_code" != 0 ]]; then
    echo "Hosted Compose cleanup failed: project=$compose_project fixture=$compose_root code=$cleanup_code" >&2
    [[ "$exit_code" != 0 ]] || exit_code="$cleanup_code"
  fi
  exit "$exit_code"
}
node_bin="$(command -v node)"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

compose_root="$(mktemp -d "$RUNNER_TEMP/control-plane-m10-compose.XXXXXX")"
compose_suffix="$(printf '%s' "${compose_root##*.}" | tr '[:upper:]' '[:lower:]')"
compose_project="control-plane-m10-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${compose_suffix}"
printf '{"project":"%s"}\n' "$compose_project" > "$compose_root/.fixture-owner.json"
printf 'Hosted Compose fixture: project=%s directory=%s\n' "$compose_project" "$compose_root"
install -d -m 700 \
  "$compose_root/simple" \
  "$compose_root/server/control-plane" \
  "$compose_root/server/postgres" \
  "$compose_root/server/restate"
RESTATE_REQUEST_IDENTITY_PUBLIC_KEY="$(node ../../scripts/provision-restate-identity.mjs "$compose_root/server/restate")"
export RESTATE_REQUEST_IDENTITY_PUBLIC_KEY
sudo chown -R 1000:1000 "$compose_root/simple" "$compose_root/server/control-plane"
sudo chown -R 70:70 "$compose_root/server/postgres"
sudo chown -R 0:0 "$compose_root/server/restate"
export CONTROL_PLANE_PORT=33300
export CONTROL_PLANE_DATA_PATH="$compose_root/simple"
compose_started=true
compose --profile simple up --build -d
for _ in {1..60}; do
  simple_status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:33300/ready || true)"
  [[ "$simple_status" == 200 ]] && break
  sleep 2
done
test "$simple_status" = 200
credential_before="$(compose exec -T control-plane-simple sha256sum /var/lib/control-plane/auth/local-api.token | cut -d ' ' -f 1)"
compose --profile simple up -d --force-recreate
for _ in {1..60}; do
  simple_status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:33300/ready || true)"
  [[ "$simple_status" == 200 ]] && break
  sleep 2
done
test "$simple_status" = 200
credential_after="$(compose exec -T control-plane-simple sha256sum /var/lib/control-plane/auth/local-api.token | cut -d ' ' -f 1)"
test "$credential_before" = "$credential_after"
compose --profile simple down
POSTGRES_PASSWORD="$(openssl rand -hex 32)"
POSTGRES_MIGRATION_PASSWORD="$(openssl rand -hex 32)"
POSTGRES_APPLICATION_PASSWORD="$(openssl rand -hex 32)"
export POSTGRES_PASSWORD POSTGRES_MIGRATION_PASSWORD POSTGRES_APPLICATION_PASSWORD
export CONTROL_PLANE_SERVER_DATA_PATH="$compose_root/server/control-plane"
export POSTGRES_DATA_PATH="$compose_root/server/postgres"
export RESTATE_DATA_PATH="$compose_root/server/restate"
compose --profile server up -d --wait postgres
compose exec -T postgres psql -U control_plane -d control_plane -v ON_ERROR_STOP=1 -c 'create table legacy_role_upgrade_probe(id integer primary key);'
compose --profile server up --build -d
for _ in {1..60}; do
  server_status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:33300/ready || true)"
  [[ "$server_status" == 200 ]] && break
  sleep 2
done
test "$server_status" = 200
expected_migrations="$(find ../../packages/database/drizzle -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')"
applied_migrations="$(compose exec -T postgres psql -U control_plane -d control_plane -Atc 'select count(*) from drizzle.__drizzle_migrations;')"
test "$applied_migrations" = "$expected_migrations"
test "$(compose exec -T -e PGPASSWORD="$POSTGRES_MIGRATION_PASSWORD" postgres psql -h 127.0.0.1 -U control_plane_migrator -d control_plane -Atc 'select current_user;')" = control_plane_migrator
test "$(compose exec -T -e PGPASSWORD="$POSTGRES_APPLICATION_PASSWORD" postgres psql -h 127.0.0.1 -U control_plane_app -d control_plane -Atc 'select current_user;')" = control_plane_app
test "$(compose exec -T postgres psql -U control_plane -d control_plane -Atc 'select rolsuper or rolcreatedb or rolcreaterole or rolbypassrls from pg_roles where rolname = $$control_plane_app$$;')" = f
test "$(compose exec -T postgres psql -U control_plane -d control_plane -Atc 'select pg_get_userbyid(datdba) = $$control_plane_app$$ from pg_database where datname = $$control_plane$$;')" = f
test "$(compose exec -T postgres psql -U control_plane -d control_plane -Atc 'select count(*) from pg_auth_members where member = (select oid from pg_roles where rolname = $$control_plane_app$$);')" = 0
test "$(compose exec -T postgres psql -U control_plane -d control_plane -Atc 'select count(*) from information_schema.role_table_grants where grantee = $$control_plane_app$$ and privilege_type not in ($$SELECT$$, $$INSERT$$, $$UPDATE$$, $$DELETE$$);')" = 0
test "$(compose exec -T postgres psql -U control_plane -d control_plane -Atc 'select tableowner from pg_tables where schemaname = $$public$$ and tablename = $$legacy_role_upgrade_probe$$;')" = control_plane_migrator
test "$(compose exec -T -e PGPASSWORD="$POSTGRES_APPLICATION_PASSWORD" postgres psql -h 127.0.0.1 -U control_plane_app -d control_plane -v ON_ERROR_STOP=1 -qAtc 'begin; insert into legacy_role_upgrade_probe values (1); update legacy_role_upgrade_probe set id = 2 where id = 1; delete from legacy_role_upgrade_probe where id = 2; select count(*) from legacy_role_upgrade_probe; commit;')" = 0
if compose exec -T -e PGPASSWORD="$POSTGRES_APPLICATION_PASSWORD" postgres psql -h 127.0.0.1 -U control_plane_app -d control_plane -v ON_ERROR_STOP=1 -c 'create table runtime_role_must_not_create_objects(id integer);'; then
  echo 'Application database role unexpectedly has DDL privileges.' >&2
  exit 1
fi
if compose run --rm --no-deps -e POSTGRES_APPLICATION_PASSWORD="$POSTGRES_MIGRATION_PASSWORD" database-bootstrap; then
  echo 'Database role bootstrap unexpectedly accepted duplicate passwords.' >&2
  exit 1
fi
compose --profile server stop restate
test "$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:33300/ready)" = 503
compose --profile server up --detach --wait --wait-timeout 120 restate
for _ in {1..60}; do
  server_status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:33300/ready || true)"
  [[ "$server_status" == 200 ]] && break
  sleep 2
done
test "$server_status" = 200
compose --profile server stop postgres
test "$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:33300/ready)" = 503
compose --profile server up --detach --wait --wait-timeout 120 postgres
for _ in {1..60}; do
  server_status="$(curl --silent --max-time 5 --output /dev/null --write-out '%{http_code}' http://127.0.0.1:33300/ready || true)"
  [[ "$server_status" == 200 ]] && break
  sleep 2
done
test "$server_status" = 200
