#!/bin/sh
set -eu

: "${CONTROL_PLANE_PI_AGENT_CONFIG_DIRECTORY:?Set the private managed-Pi configuration directory}"
: "${PI_CODING_AGENT_DIR:?Set the private managed-Pi runtime directory}"
: "${CONTROL_PLANE_MANAGED_PI_EXECUTABLE:?Set the pinned managed-Pi executable}"

node /usr/local/bin/sync-managed-pi-config.mjs \
  "$CONTROL_PLANE_PI_AGENT_CONFIG_DIRECTORY" \
  "$PI_CODING_AGENT_DIR"

env -i PATH="$PATH" PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
  node /usr/local/lib/control-plane/managed-pi-version-preflight.mjs \
  "$CONTROL_PLANE_MANAGED_PI_EXECUTABLE"

exec /usr/local/bin/control-plane-entrypoint "$@"
