# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

# Cached tokens for the local DMS stack. Source this file:  source stack/dms/dms-token.sh
# Then:  TOKEN=$(dmstoken lea)   # lea | school | core | seeder | cms-ro | cms-admin
# Credentials come from stack/dms/.env.dms-clients and stack/dms/.env.dms (written by
# stack/setup-dms-clients.ps1) and, for cms-admin, from the DMS checkout's eng/docker-compose/.env
# (DMS_COMPOSE_DIR, default ../Data-Management-Service/eng/docker-compose beside this repository).
# Sourcing also exports the DMS_* variables from .env.dms-clients (DMS_LEA_KEY, DMS_ONEROSTER_URL,
# CMS_URL, ...). Tokens are cached in stack/dms/.tokens/ (git-ignored) until 60 s before expiry. The
# self-contained identity provider allows only 15 active tokens per client (429 beyond that), so
# never mint one per request. After a DMS wipe, delete stack/dms/.tokens/.
_DMS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_OR_REPO="$(cd "$_DMS_DIR/../.." && pwd)"
_DMS_STACK_ENV="${DMS_COMPOSE_DIR:-$_OR_REPO/../Data-Management-Service/eng/docker-compose}/.env"
set -a; source "$_DMS_DIR/.env.dms-clients"; set +a

_envval() { grep -E "^$1=" "$2" | tail -1 | cut -d= -f2- | sed -e "s/^['\"]//" -e "s/['\"]$//"; }

dmstoken() {
  local who="$1" id secret scope cache now
  case "$who" in
    lea)       id="$DMS_LEA_KEY";    secret="$DMS_LEA_SECRET";    scope="OneRoster-ReadOnly" ;;
    school)    id="$DMS_SCHOOL_KEY"; secret="$DMS_SCHOOL_SECRET"; scope="OneRoster-ReadOnly" ;;
    core)      id="$DMS_CORE_KEY";   secret="$DMS_CORE_SECRET";   scope="OneRoster-Core" ;;
    seeder)    id="$DMS_SEEDER_KEY"; secret="$DMS_SEEDER_SECRET"; scope="SeedLoader" ;;
    cms-ro)    id="$(_envval CONFIG_SERVICE_CLIENT_ID "$_DMS_DIR/.env.dms")"
               secret="$(_envval CONFIG_SERVICE_CLIENT_SECRET "$_DMS_DIR/.env.dms")"
               scope="edfi_admin_api/authMetadata_readonly_access" ;;
    cms-admin) id="$(_envval CONFIGURATION_SERVICE_IDENTITY_CLIENT_ID "$_DMS_STACK_ENV")"
               secret="$(_envval CONFIGURATION_SERVICE_IDENTITY_CLIENT_SECRET "$_DMS_STACK_ENV")"
               scope="edfi_admin_api/full_access" ;;
    *) echo "usage: dmstoken lea|school|core|seeder|cms-ro|cms-admin" >&2; return 2 ;;
  esac
  cache="$_DMS_DIR/.tokens/$who"; now=$(date +%s)
  if [ -f "$cache" ] && [ "$(head -1 "$cache")" -gt $((now + 60)) ]; then tail -1 "$cache"; return; fi
  mkdir -p "$_DMS_DIR/.tokens"; chmod 700 "$_DMS_DIR/.tokens"
  curl -sf "$CMS_URL/connect/token" --data-urlencode grant_type=client_credentials \
    --data-urlencode "client_id=$id" --data-urlencode "client_secret=$secret" --data-urlencode "scope=$scope" \
    | python3 -c 'import json,sys,time; d=json.load(sys.stdin); print(int(time.time())+int(d["expires_in"])); print(d["access_token"])' \
    > "$cache.tmp" && chmod 600 "$cache.tmp" && mv "$cache.tmp" "$cache" && tail -1 "$cache"
}

# Print a JWT payload with the signature dropped.
jwtpayload() { python3 -c 'import base64,json,sys; p=sys.argv[1].split(".")[1]; print(json.dumps(json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4))),indent=2))' "$1"; }
