# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

<#
.SYNOPSIS
    Runs the Bruno suites against the OneRoster service on a local Ed-Fi ODS/API stack that is
    already running.

.DESCRIPTION
    Reads the LEA and School client credentials, URLs and MAX_PAGE_SIZE from the stack's env file
    (the one the stack was started with), then runs the main collection (tests) with
    environments/ci.bru. With tests-assessment in -Folders it also runs the assessment rostering
    suite with environments/assessment-ods.bru, which needs the school 255901001 client from
    tests/bruno/create-assessment-clients.py. Credentials are passed to Bruno through the process
    environment and never printed. Unlike run-bruno-e2e.ps1, it doesn't start or stop the stack.

    The service allows 100 requests a minute per client, and the ODS/API caps active tokens per
    client: wait a minute between full runs.

.EXAMPLE
    pwsh ./tests/bruno/run-bruno-ods.ps1 -EnvFile stack/pgsql/.env.5.2.0

.EXAMPLE
    pwsh ./tests/bruno/run-bruno-ods.ps1 -EnvFile stack/pgsql/.env.5.2.0 -Folders tests,tests-assessment

.EXAMPLE
    # The assessment suite against a separate service instance, here one on port 3103
    pwsh ./tests/bruno/run-bruno-ods.ps1 -EnvFile stack/pgsql/.env.5.2.0 -Folders tests-assessment -OneRosterUrl http://localhost:3103
#>

param(
    [Parameter(Mandatory = $true)]
    [string]
    $EnvFile,

    [string[]]
    $Folders = @("tests"),

    [string]
    $AssessmentClientsFile = (Join-Path $PSScriptRoot ".env.assessment-clients"),

    # Overrides BASE_URL/ONEROSTER_API_VIRTUAL_NAME for the OneRoster service only
    [string]
    $OneRosterUrl,

    [string]
    $BrunoVersion = "3.2.0"
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "../../stack/env-utility.psm1") -Force

if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    throw "$EnvFile was not found."
}
$stackEnv = ReadValuesFromEnvFile -EnvironmentFile (Resolve-Path -LiteralPath $EnvFile)
foreach ($key in 'BASE_URL', 'ODS_API_VIRTUAL_NAME', 'ONEROSTER_API_VIRTUAL_NAME', 'LEA_KEY', 'LEA_SECRET', 'SCHOOL_KEY', 'SCHOOL_SECRET') {
    if (-not $stackEnv[$key]) { throw "$key is not set in $EnvFile." }
    [System.Environment]::SetEnvironmentVariable($key, $stackEnv[$key], "Process")
}
$env:MAX_PAGE_SIZE = if ($stackEnv["MAX_PAGE_SIZE"]) { $stackEnv["MAX_PAGE_SIZE"] } else { "500" }

if ($Folders -contains "tests-assessment") {
    if (-not (Test-Path -LiteralPath $AssessmentClientsFile -PathType Leaf)) {
        throw "$AssessmentClientsFile was not found. Run tests/bruno/create-assessment-clients.py first."
    }
    $clients = ReadValuesFromEnvFile -EnvironmentFile $AssessmentClientsFile
    if (-not $clients["ODS_SCHOOL001_KEY"] -or -not $clients["ODS_SCHOOL001_SECRET"]) {
        throw "ODS_SCHOOL001_KEY/SECRET are not in $AssessmentClientsFile. Run tests/bruno/create-assessment-clients.py."
    }
    $env:ASSESSMENT_SCHOOL_KEY = $clients["ODS_SCHOOL001_KEY"]
    $env:ASSESSMENT_SCHOOL_SECRET = $clients["ODS_SCHOOL001_SECRET"]
}

# The stack's self-signed certificate
$certificate = Join-Path $PSScriptRoot "../../stack/ssl/server.crt"
if (Test-Path -LiteralPath $certificate -PathType Leaf) {
    $env:NODE_EXTRA_CA_CERTS = (Resolve-Path -LiteralPath $certificate).Path
}

$environments = @{ "tests" = "environments/ci.bru"; "tests-assessment" = "environments/assessment-ods.bru" }

$failed = @()
Push-Location $PSScriptRoot
try {
    foreach ($folder in $Folders) {
        $environment = $environments[$folder]
        if (-not $environment) { throw "No ODS environment for folder '$folder' (expected tests or tests-assessment)." }
        $brunoArgs = @("-y", "-p", "@usebruno/cli@$BrunoVersion", "bru", "run", $folder, "-r", "--env-file", $environment)
        if ($OneRosterUrl) { $brunoArgs += @("--env-var", "oneRosterUrl=$OneRosterUrl") }
        Write-Host "Running Bruno folder '$folder' with $environment" -ForegroundColor Cyan
        & npx @brunoArgs
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
Write-Host "All Bruno ODS runs passed." -ForegroundColor Green
