#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.
"""Create the school 255901001 OneRoster clients that the assessment rostering Bruno suite uses.

The stacks' School clients are ed-org 255901107, which has no assessment registrations in the
Grand Bend sample, so tests/bruno/tests-assessment needs a client for school 255901001.

- ODS stack (PostgreSQL): application "Assessment Test Application" (vendor "Test Vendor", claim set
  "Ed-Fi Sandbox") with API client "School 255901001 Test Api Client". A separate application,
  because stack/settings/bootstrap.sh resets every ed-org link on "Test Application" when rerun.
  Run start-services.ps1 -InitializeAdminClients first. The SQL Server ODS stack isn't covered.
- DMS stack: application "OneRoster School 255901001" (vendor "1EdTech OneRoster (local)",
  claim set OneRoster-ReadOnly) on the stack's data store. Run stack/setup-dms-clients.ps1 first.

Credentials go to tests/bruno/.env.assessment-clients (mode 600, git-ignored) as
ODS_SCHOOL001_KEY/SECRET and DMS_SCHOOL001_KEY/SECRET, single-quoted so the file can be sourced.
Nothing secret is printed. Idempotent: an existing client whose credentials are in the file is
kept. --reset-dms rotates the DMS application's credentials. For another DMS stack (SQL Server):
--skip-ods --dms-clients <its .env.dms-clients file> --dms-prefix DMS_MSSQL_SCHOOL001.
--skip-dms creates only the ODS client.

The DMS Configuration Service credentials come from the DMS checkout's eng/docker-compose/.env:
pass --dms-compose-dir or set DMS_COMPOSE_DIR to that directory (default:
../Data-Management-Service/eng/docker-compose beside this repository). --help lists the options.

Remove: ODS: delete the API client, its links and the application from EdFi_Admin.
DMS: DELETE /v3/applications/<id> in the Configuration Service.
"""
import argparse
import json
import os
import secrets
import subprocess
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CREDS_FILE = os.path.join(HERE, ".env.assessment-clients")
DEFAULT_DMS_COMPOSE_DIR = os.environ.get("DMS_COMPOSE_DIR") or os.path.join(os.path.dirname(REPO), "Data-Management-Service", "eng", "docker-compose")
DMS_CLIENTS_ENV = os.path.join(REPO, "stack", "dms", ".env.dms-clients")
CMS_URL = "http://localhost:8081"
SCHOOL_ID = 255901001

ODS_APP = "Assessment Test Application"
ODS_CLIENT = "School 255901001 Test Api Client"
DMS_APP = "OneRoster School 255901001"
DMS_VENDOR = "1EdTech OneRoster (local)"


def read_env(path):
    values = {}
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def write_creds(creds):
    fd = os.open(CREDS_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write("# School 255901001 OneRoster clients (create-assessment-clients.py). Don't commit.\n")
        for key in sorted(creds):
            # Single-quoted so the file can be sourced: CMS secrets contain glob characters
            value = creds[key].replace("'", "'\\''")
            handle.write(f"{key}='{value}'\n")
    os.chmod(CREDS_FILE, 0o600)


def psql_admin(sql):
    # SQL goes in on stdin, so the secret never appears in a process argument list
    result = subprocess.run(
        ["docker", "exec", "-i", "db-admin", "psql", "-U", "postgres", "-d", "EdFi_Admin", "-v", "ON_ERROR_STOP=1", "-Atq"],
        input=sql, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"EdFi_Admin query failed: {result.stderr.strip()}")
    return result.stdout.strip()


def ods_client(creds):
    existing = psql_admin(f"select ApiClientId from dbo.ApiClients where Name = '{ODS_CLIENT}';")
    if existing and creds.get("ODS_SCHOOL001_KEY") and creds.get("ODS_SCHOOL001_SECRET"):
        print(f"ODS: kept {ODS_CLIENT}")
        return
    if existing:
        sys.exit(f"ODS: {ODS_CLIENT} exists but its credentials aren't in {CREDS_FILE}. Remove it first.")

    # A fresh EdFi_Admin (another data standard, a restored volume) gets the credentials already in
    # the file, so every ODS stack accepts the same client
    key = creds.get("ODS_SCHOOL001_KEY") or secrets.token_hex(10)
    secret = creds.get("ODS_SCHOOL001_SECRET") or secrets.token_urlsafe(24)
    psql_admin(f"""
DO $$
DECLARE
  vendor_id int := (select VendorId from dbo.Vendors where VendorName = 'Test Vendor');
  user_id int;
  ods_instance_id int := (select OdsInstanceId from dbo.OdsInstances where Name = 'Ods Instance' and InstanceType = 'ODS');
  application_id int;
  app_edorg_id int;
  api_client_id int;
BEGIN
  IF vendor_id IS NULL OR ods_instance_id IS NULL THEN
    RAISE EXCEPTION 'Test Vendor or Ods Instance missing: run start-services.ps1 -InitializeAdminClients first';
  END IF;
  SELECT UserId INTO user_id FROM dbo.Users WHERE Vendor_VendorId = vendor_id ORDER BY UserId LIMIT 1;

  SELECT ApplicationId INTO application_id FROM dbo.Applications WHERE ApplicationName = '{ODS_APP}' AND Vendor_VendorId = vendor_id;
  IF application_id IS NULL THEN
    INSERT INTO dbo.Applications (ApplicationName, Vendor_VendorId, ClaimSetName) VALUES ('{ODS_APP}', vendor_id, 'Ed-Fi Sandbox');
    SELECT LASTVAL() INTO application_id;
  END IF;

  INSERT INTO dbo.ApiClients (Key, Secret, Name, IsApproved, UseSandbox, SandboxType, Application_ApplicationId, User_UserId, SecretIsHashed)
  VALUES ('{key}', '{secret}', '{ODS_CLIENT}', TRUE, FALSE, 0, application_id, user_id, FALSE);
  SELECT LASTVAL() INTO api_client_id;

  INSERT INTO dbo.ApiClientOdsInstances (ApiClient_ApiClientId, OdsInstance_OdsInstanceId) VALUES (api_client_id, ods_instance_id);

  INSERT INTO dbo.ApplicationEducationOrganizations (EducationOrganizationId, Application_ApplicationId) VALUES ({SCHOOL_ID}, application_id);
  SELECT LASTVAL() INTO app_edorg_id;
  INSERT INTO dbo.ApiClientApplicationEducationOrganizations (ApplicationEdOrg_ApplicationEdOrgId, ApiClient_ApiClientId) VALUES (app_edorg_id, api_client_id);
END $$;
""")
    creds["ODS_SCHOOL001_KEY"] = key
    creds["ODS_SCHOOL001_SECRET"] = secret
    print(f"ODS: created {ODS_CLIENT} in {ODS_APP} (Ed-Fi Sandbox, ed-org {SCHOOL_ID})")


def cms(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(CMS_URL + path, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request) as response:
            text = response.read().decode()
            return json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        sys.exit(f"CMS {method} {path} failed: HTTP {error.code}")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Create the school 255901001 OneRoster clients that tests/bruno/tests-assessment uses.")
    parser.add_argument("--skip-ods", action="store_true", help="don't create the ODS client")
    parser.add_argument("--skip-dms", action="store_true", help="don't create the DMS client")
    parser.add_argument("--reset-dms", action="store_true", help="rotate the DMS application's credentials")
    parser.add_argument("--dms-clients", default=DMS_CLIENTS_ENV, metavar="FILE",
                        help="the DMS stack's clients file from setup-dms-clients.ps1 (default: stack/dms/.env.dms-clients)")
    parser.add_argument("--dms-prefix", default="DMS_SCHOOL001", metavar="NAME",
                        help="variable prefix for the DMS credentials (default: DMS_SCHOOL001)")
    parser.add_argument("--dms-compose-dir", default=DEFAULT_DMS_COMPOSE_DIR, metavar="DIR",
                        help="the Data-Management-Service eng/docker-compose directory, for its .env "
                             "(default: DMS_COMPOSE_DIR, or ../Data-Management-Service/eng/docker-compose beside this repository)")
    return parser.parse_args(argv)


def dms_client(creds, args):
    prefix = args.dms_prefix
    stack_env_file = os.path.join(args.dms_compose_dir, ".env")
    if not os.path.exists(stack_env_file):
        sys.exit(f"DMS: no .env in {args.dms_compose_dir}. Pass --dms-compose-dir (or set DMS_COMPOSE_DIR) "
                 "to the Data-Management-Service eng/docker-compose directory.")
    if not os.path.exists(args.dms_clients):
        sys.exit(f"DMS: {args.dms_clients} not found: run stack/setup-dms-clients.ps1 first, or pass --dms-clients.")
    stack_env = read_env(stack_env_file)
    clients_env = read_env(args.dms_clients)
    form = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": stack_env["CONFIGURATION_SERVICE_IDENTITY_CLIENT_ID"],
        "client_secret": stack_env["CONFIGURATION_SERVICE_IDENTITY_CLIENT_SECRET"],
        "scope": "edfi_admin_api/full_access",
    }).encode()
    with urllib.request.urlopen(urllib.request.Request(f"{CMS_URL}/connect/token", data=form)) as response:
        token = json.load(response)["access_token"]

    vendor = next((v for v in cms("GET", "/v3/vendors", token) if v["company"] == DMS_VENDOR), None)
    if vendor is None:
        sys.exit(f"DMS: vendor '{DMS_VENDOR}' missing: run stack/setup-dms-clients.ps1 first")
    existing = next((a for a in cms("GET", f"/v3/vendors/{vendor['id']}/applications", token) if a["applicationName"] == DMS_APP), None)
    if existing and args.reset_dms:
        reset = cms("PUT", f"/v3/applications/{existing['id']}/reset-credential", token)
        creds[f"{prefix}_KEY"] = reset["key"]
        creds[f"{prefix}_SECRET"] = reset["secret"]
        print(f"DMS: rotated the credentials of {DMS_APP}")
        return
    if existing and creds.get(f"{prefix}_KEY") and creds.get(f"{prefix}_SECRET"):
        print(f"DMS: kept {DMS_APP}")
        return
    if existing:
        sys.exit(f"DMS: {DMS_APP} exists but its credentials aren't in {CREDS_FILE}. Remove it first.")

    created = cms("POST", "/v3/applications", token, {
        "applicationName": DMS_APP,
        "vendorId": vendor["id"],
        "claimSetName": "OneRoster-ReadOnly",
        "educationOrganizationIds": [SCHOOL_ID],
        "dataStoreIds": [int(clients_env["DMS_DATA_STORE_ID"])],
    })
    creds[f"{prefix}_KEY"] = created["key"]
    creds[f"{prefix}_SECRET"] = created["secret"]
    print(f"DMS: created {DMS_APP} (OneRoster-ReadOnly, ed-org {SCHOOL_ID}, data store {clients_env['DMS_DATA_STORE_ID']})")


def main():
    args = parse_args()
    creds = read_env(CREDS_FILE) if os.path.exists(CREDS_FILE) else {}
    if not args.skip_ods:
        ods_client(creds)
        write_creds(creds)
    if not args.skip_dms:
        dms_client(creds, args)
        write_creds(creds)
    print(f"Credentials: {CREDS_FILE} (mode 600)")


if __name__ == "__main__":
    main()
