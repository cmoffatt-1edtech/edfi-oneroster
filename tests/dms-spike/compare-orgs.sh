#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

# Phase 0 spike: diff tests/dms-spike/orgs.sql (run on the local DMS data store) against
# oneroster12.orgs on the local ODS stack. dateLastModified is compared separately because the
# two platforms stamp different load times.
#   DMS_PGPASSWORD=... tests/dms-spike/compare-orgs.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT_DIR:-$(mktemp -d)}"

rows='select row_to_json(o) from (%s) o order by "sourcedId"'
PGPASSWORD="$DMS_PGPASSWORD" psql -h localhost -p "${DMS_PGPORT:-5435}" -U postgres -d edfi_datamanagementservice -Atq \
  -c "$(printf "$rows" "$(sed -e 's/;[[:space:]]*$//' orgs.sql | grep -v '^--')")" > "$OUT/dms.jsonl"
docker exec db-ods psql -U postgres -d EdFi_Ods -Atq \
  -c "$(printf "$rows" 'select * from oneroster12.orgs')" > "$OUT/ods.jsonl"

python3 - "$OUT/ods.jsonl" "$OUT/dms.jsonl" <<'EOF'
import json, sys
load = lambda p: {r["sourcedId"]: r for r in map(json.loads, open(p))}
ods, dms = load(sys.argv[1]), load(sys.argv[2])
print(f"rows: ods={len(ods)} dms={len(dms)}")
for k in sorted(ods.keys() - dms.keys()): print(f"only in ODS: {k} {ods[k]['type']} {ods[k]['identifier']} {ods[k]['name']}")
for k in sorted(dms.keys() - ods.keys()): print(f"only in DMS: {k} {dms[k]['type']} {dms[k]['identifier']} {dms[k]['name']}")
same = sorted(ods.keys() & dms.keys())
for k in same:
    a, b = dict(ods[k]), dict(dms[k])
    ta, tb = a.pop("dateLastModified"), b.pop("dateLastModified")
    # children order is not defined by json_agg; compare as sets
    for r in (a, b):
        if r["children"]: r["children"] = sorted(r["children"], key=lambda c: c["sourcedId"])
    diffs = [f for f in a if a[f] != b.get(f)]
    print(f"{k} {a['type']:<8} {a['identifier']:<10} {'IDENTICAL' if not diffs else 'DIFF ' + ','.join(diffs)}  ods={ta}  dms={tb}")
    if a["children"] != b["children"]:
        ca = {c["sourcedId"] for c in a["children"] or []}; cb = {c["sourcedId"] for c in b["children"] or []}
        print(f"   children only in ODS: {sorted(ca - cb)}  only in DMS: {sorted(cb - ca)}")
EOF
echo "raw rows: $OUT"
