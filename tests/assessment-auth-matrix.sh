#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

# Run tests/assessment-auth-matrix.js in a throwaway container on both local stacks' Docker networks,
# with the same ODS_PG / DMS_PG settings as tests/compare-dms-database.sh (superuser logins). Nothing
# is kept: each database's load, scratch schema and queries are rolled back.
#   ODS_PG=... DMS_PG=... tests/assessment-auth-matrix.sh [--platforms ods]
set -euo pipefail
COMPARE_SCRIPT=tests/assessment-auth-matrix.js exec "$(dirname "$0")/compare-dms-database.sh" "$@"
