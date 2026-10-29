#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

# Run tests/compare-dms-fixture.js in a throwaway container on both local stacks' Docker networks,
# with the same ODS_PG / DMS_PG settings as tests/compare-dms-database.sh. Both logins must be
# superusers (the run sets session_replication_role). Nothing is kept: each database's load is
# rolled back.
#   ODS_PG=... DMS_PG=... tests/compare-dms-fixture.sh [--json /out/fixture.json]
set -euo pipefail
COMPARE_SCRIPT=tests/compare-dms-fixture.js exec "$(dirname "$0")/compare-dms-database.sh" "$@"
