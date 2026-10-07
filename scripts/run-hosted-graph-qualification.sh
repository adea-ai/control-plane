#!/usr/bin/env bash
set -euo pipefail

# This qualifier uses the current shard's database, never another Neon preview.
# Keep the developer's Docker engine out of this CI-only entry point.
[[ "${GITHUB_ACTIONS:-}" == true ]] || { echo 'GitHub Actions runner required.' >&2; exit 2; }
[[ "${RUNNER_TEMP:-}" == /* && -d "$RUNNER_TEMP" ]] || { echo 'Absolute existing RUNNER_TEMP required.' >&2; exit 2; }
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || { echo 'Numeric run identity required.' >&2; exit 2; }
[[ -n "${DATABASE_URL:-}" && -n "${DATABASE_ADMIN_URL:-}" && -n "${DATABASE_MIGRATION_URL:-}" ]] || { echo 'Existing shard database credentials required.' >&2; exit 2; }

fixture_root=''
fixture_owner=''
container_name=''
container_attempted=false
test_pid=''
test_reaped=false
test_output_printed=false
node_bin="$(command -v node)"
owner_label='control-plane.hosted-graph.owner'

docker_command() {
  timeout --signal=TERM --kill-after=5s 120s docker "$@"
}

record_test() {
  printf '{"owner":"%s","container":"%s","state":"planned","scriptPid":%s,"ports":[19070,19080,33330,33331],"test":{"command":"timeout 480s bun test hosted-graph.integration.test.mjs","pid":%s,"state":"%s","exitCode":%s}}\n' "$fixture_owner" "$container_name" "$$" "${test_pid:-null}" "$1" "${2:-null}" > "$fixture_root/resources.json"
}

cleanup() {
  local exit_code="$?" cleanup_code=0 containers=''
  trap - EXIT HUP INT TERM
  set +e
  if [[ -n "$test_pid" && "$test_reaped" != true ]]; then
    # Only signal a child still owned by this shell. GNU timeout forwards TERM
    # to its test process group and escalates after its configured five seconds.
    if jobs -pr | grep -Fxq "$test_pid"; then kill -TERM "$test_pid"; fi
    wait "$test_pid"
    test_code="$?"
    test_reaped=true
    record_test reaped "$test_code"
  fi
  if [[ "$test_output_printed" != true && -f "$fixture_root/test.log" ]]; then
    cat "$fixture_root/test.log"
  fi
  if [[ "$container_attempted" == true ]]; then
    containers="$(docker_command container ls --all --filter "name=${container_name}" --format "{{.Names}}|{{.Label \"$owner_label\"}}")"
    cleanup_code="$?"
    if [[ "$cleanup_code" == 0 && -n "$containers" ]]; then
      if [[ "$containers" == "$container_name|$fixture_owner" ]]; then
        docker_command container rm --force "$container_name"
        cleanup_code="$?"
        if [[ "$cleanup_code" == 0 ]]; then
          containers="$(docker_command container ls --all --filter "name=${container_name}" --format '{{.Names}}')"
          cleanup_code="$?"
          [[ -z "$containers" ]] || cleanup_code=71
        fi
      else
        cleanup_code=71
      fi
    fi
  fi
  if [[ "$cleanup_code" == 0 && -n "$fixture_root" ]]; then
    timeout --signal=TERM --kill-after=5s 20s "$node_bin" scripts/remove-hosted-compose-fixture.mjs "$RUNNER_TEMP" "$fixture_root" "$fixture_owner"
    cleanup_code="$?"
  fi
  if [[ "$cleanup_code" != 0 ]]; then
    echo "Hosted graph cleanup failed: container=$container_name fixture=$fixture_root code=$cleanup_code" >&2
    [[ "$exit_code" != 0 ]] || exit_code="$cleanup_code"
  fi
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fixture_root="$(mktemp -d "$RUNNER_TEMP/control-plane-m10-compose.XXXXXX")"
fixture_suffix="$(printf '%s' "${fixture_root##*.}" | tr '[:upper:]' '[:lower:]')"
fixture_owner="control-plane-m10-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${fixture_suffix}"
container_name="$fixture_owner-graph-restate"
printf '{"project":"%s"}\n' "$fixture_owner" > "$fixture_root/.fixture-owner.json"
printf '{"owner":"%s","container":"%s","state":"planned","scriptPid":%s,"ports":[19070,19080,33330,33331]}\n' "$fixture_owner" "$container_name" "$$" > "$fixture_root/resources.json"
install -d -m 700 "$fixture_root/identity"
"$node_bin" scripts/provision-restate-identity.mjs "$fixture_root/identity" > "$fixture_root/public-key.txt"

# Reuse the supported Compose pin rather than creating a second version policy.
restate_image="$(sed -n '/^  restate:/,/^  [a-z].*:/ {s/^    image: //p;}' infrastructure/compose/compose.yaml)"
[[ "$restate_image" =~ ^docker\.restate\.dev/restatedev/restate:[0-9.]+@sha256:[a-f0-9]{64}$ ]] || { echo 'Digest-pinned Restate image required.' >&2; exit 2; }
container_attempted=true
runner_uid="$(id -u)"
runner_gid="$(id -g)"
docker_command run --detach --name "$container_name" --label "$owner_label=$fixture_owner" \
  --user "$runner_uid:$runner_gid" \
  --network host --restart no --cpus 1.5 --memory 1g --pids-limit 256 \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --tmpfs "/restate-data:rw,nosuid,nodev,size=256m,uid=$runner_uid,gid=$runner_gid,mode=0700" \
  --mount "type=bind,source=$fixture_root/identity/request-identity-private.pem,target=/identity/key.pem,readonly" \
  --env RESTATE_ADMIN__BIND_ADDRESS=127.0.0.1:19070 \
  --env RESTATE_INGRESS__BIND_ADDRESS=127.0.0.1:19080 \
  --env RESTATE_ADMIN__QUERY_ENGINE__MEMORY_SIZE='64 MiB' \
  --env RESTATE_ROCKSDB_TOTAL_MEMORY_SIZE='384 MiB' \
  --env RESTATE_AUTO_PROVISION=true --env RESTATE_BASE_DIR=/restate-data \
  --env RESTATE_BIND_IP=127.0.0.1 --env RESTATE_CLUSTER_NAME="$fixture_owner" \
  --env RESTATE_NODE_NAME="$fixture_owner" --env RESTATE_DISABLE_TELEMETRY=true \
  --env RESTATE_SHUTDOWN_TIMEOUT=20s \
  --env RESTATE_WORKER__INVOKER__REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE=/identity/key.pem \
  "$restate_image" > "$fixture_root/container-id.txt"

ready=false
for _ in {1..60}; do
  if curl --fail --silent --show-error --max-time 2 http://127.0.0.1:19070/health >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Hosted graph Restate readiness failed.' >&2; exit 1; }

export RUN_DATABASE_INTEGRATION=true RUN_HOSTED_GRAPH_RESTATE_INTEGRATION=true NO_COLOR=1
export INTEGRATION_TEST_TIMEOUT_MS=120000
install -d -m 700 "$fixture_root/test-tmp"
export TMPDIR="$fixture_root/test-tmp"
export HOSTED_GRAPH_TEST_PUBLIC_KEY_FILE="$fixture_root/public-key.txt"
export HOSTED_GRAPH_TEST_RESTATE_ADMIN_URL=http://127.0.0.1:19070
export HOSTED_GRAPH_TEST_RESTATE_INGRESS_URL=http://127.0.0.1:19080
export HOSTED_GRAPH_TEST_API_PORT=33330 HOSTED_GRAPH_TEST_ENDPOINT_PORT=33331
export HOSTED_GRAPH_TEST_DEPLOYMENT_URI=http://127.0.0.1:33331
record_test planned
# A background child lets Bash's interruptible wait dispatch cancellation traps
# immediately. Capture output inside the owned fixture; print it after reaping.
echo 'Starting Hosted graph qualification (480s maximum).'
timeout --signal=TERM --kill-after=5s 480s bun test --timeout 120000 ./apps/hosted-control-plane/src/hosted-graph.integration.test.mjs > "$fixture_root/test.log" 2>&1 &
test_pid="$!"
record_test running
set +e
wait "$test_pid"
test_code="$?"
set -e
test_reaped=true
record_test reaped "$test_code"
cat "$fixture_root/test.log"
test_output_printed=true
[[ "$test_code" == 0 ]] || exit "$test_code"
grep -Fq '(pass) Hosted Server graph over PostgreSQL and Restate > accepts, checkpoints, parks, cold-resumes, writes one artifact, and charges once' "$fixture_root/test.log"
grep -Eq '^[[:space:]]*1 pass$' "$fixture_root/test.log"
if grep -Eq '^[[:space:]]*[1-9][0-9]* (fail|skip)$' "$fixture_root/test.log"; then
  echo 'Hosted graph qualification cannot contain failures or skips.' >&2
  exit 1
fi
