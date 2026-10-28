#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

# Run tests/compare-dms-database.js in a throwaway container attached to the local ODS stack's
# network and the DMS stack's network, since neither database needs to be published to the host.
#   ODS_PG="host=db-ods;port=5432;username=postgres;password=...;database=EdFi_Ods" \
#   DMS_PG="host=dms-postgresql;port=5432;username=postgres;password=...;database=edfi_datamanagementservice" \
#   tests/compare-dms-database.sh [--views users] [--json /app/out.json]
# Networks default to edfioneroster-network and dms (ODS_NETWORK / DMS_NETWORK override them).
set -euo pipefail
: "${ODS_PG:?set ODS_PG}" "${DMS_PG:?set DMS_PG}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NAME="oneroster-dms-compare-$$"
IMAGE="${COMPARE_IMAGE:-node:22-alpine}"
OUT_DIR="${OUT_DIR:-$REPO/tests/.dms-compare}"
mkdir -p "$OUT_DIR"

docker create --name "$NAME" --network "${ODS_NETWORK:-edfioneroster-network}" \
  -v "$REPO":/app:ro -v "$OUT_DIR":/out -w /app -e ODS_PG -e DMS_PG \
  "$IMAGE" node tests/compare-dms-database.js "$@" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker network connect "${DMS_NETWORK:-dms}" "$NAME"
docker start -a "$NAME"
