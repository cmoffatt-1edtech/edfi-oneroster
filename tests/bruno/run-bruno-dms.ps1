# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

<#
.SYNOPSIS
    Runs the Bruno suites against the OneRoster service on a local Ed-Fi API v8 (DMS) stack.

.DESCRIPTION
    Reads the client credentials and URLs from stack/dms/.env.dms-clients (written by
    stack/setup-dms-clients.ps1) and MAX_PAGE_SIZE from stack/dms/.env.dms, then runs the main
    collection (tests) and the DMS-only checks (tests-dms) with environments/dms.bru. Credentials
    are passed to Bruno through the process environment and never printed.

    The service allows 100 requests a minute per client: wait a minute between full runs.

.EXAMPLE
    pwsh ./tests/bruno/run-bruno-dms.ps1

.EXAMPLE
    pwsh ./tests/bruno/run-bruno-dms.ps1 -Folders tests-dms
#>

param(
    [string[]]
    $Folders = @("tests", "tests-dms"),

    [string]
    $ClientsFile = (Join-Path $PSScriptRoot "../../stack/dms/.env.dms-clients"),

    [string]
    $ServiceEnvFile = (Join-Path $PSScriptRoot "../../stack/dms/.env.dms"),

    [string]
    $BrunoVersion = "3.2.0"
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "../../stack/env-utility.psm1") -Force

if (-not (Test-Path -LiteralPath $ClientsFile -PathType Leaf)) {
    throw "$ClientsFile was not found. Run stack/setup-dms-clients.ps1 first."
}
$clients = ReadValuesFromEnvFile -EnvironmentFile $ClientsFile
foreach ($entry in $clients.GetEnumerator()) {
    if ($entry.Key -like "DMS_*") {
        [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
}

$maxPageSize = "500"
if (Test-Path -LiteralPath $ServiceEnvFile -PathType Leaf) {
    $serviceEnv = ReadValuesFromEnvFile -EnvironmentFile $ServiceEnvFile
    if ($serviceEnv["MAX_PAGE_SIZE"]) { $maxPageSize = $serviceEnv["MAX_PAGE_SIZE"] }
}
$env:MAX_PAGE_SIZE = $maxPageSize

$failed = @()
Push-Location $PSScriptRoot
try {
    foreach ($folder in $Folders) {
        Write-Host "Running Bruno folder '$folder' against $env:DMS_ONEROSTER_URL" -ForegroundColor Cyan
        & npx -y -p "@usebruno/cli@$BrunoVersion" bru run $folder -r --env-file environments/dms.bru
        if ($LASTEXITCODE -ne 0) { $failed += $folder }
    }
}
finally {
    Pop-Location
}

if ($failed.Count -gt 0) {
    Write-Error "Bruno failures in: $($failed -join ', ')"
    exit 1
}
Write-Host "All Bruno DMS runs passed." -ForegroundColor Green
