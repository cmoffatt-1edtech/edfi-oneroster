# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

<#
.SYNOPSIS
    Starts the OneRoster service on a local Ed-Fi API v8 (DMS) stack: seeds the OneRoster
    descriptors, deploys the projections and starts the container.

.DESCRIPTION
    Needs the DMS stack running (its Docker network, default "dms") and the two env files that
    setup-dms-clients.ps1 writes: dms/.env.dms and dms/.env.dms-clients. Every step runs in a
    container from the OneRoster image on the DMS network, so the host needs only Docker and
    PowerShell.

    1. Builds the image (with -Rebuild, or when it doesn't exist yet).
    2. Seeds the OneRoster descriptors and descriptor mappings through the Ed-Fi API, as the
       "OneRoster Seeder" application (standard/seed-descriptors.js; idempotent).
    3. Deploys the oneroster12 projections into each data store the Configuration Service lists,
       and creates the pg-boss database named in PG_BOSS_CONNECTION_CONFIG if it is missing
       (standard/deploy-dms.js --from-cms --jobs-database; rerunning replaces the views). With
       DB_TYPE=mssql in the service environment (a DMS stack on SQL Server) the projections are
       tables refreshed by a SQL Server Agent job, and there is no pg-boss database.
    4. Starts the service and waits until its health check passes.

    Reprovisioning a data store (a wipe, a data standard upgrade, an extension change) drops the
    oneroster12 schema with the database, and new descriptors are needed. Rerun this script after
    every reprovision; steps 2 and 3 are what bring OneRoster back.

.EXAMPLE
    pwsh ./start-dms-services.ps1 -Rebuild
    Rebuilds the image from this checkout, seeds, deploys and starts the service.

.EXAMPLE
    pwsh ./start-dms-services.ps1 -SkipSeed -SkipDeploy
    Starts the service only (the data store already has the descriptors and projections).
#>

param(
    # Rebuild the OneRoster image from this checkout before starting
    [Switch]
    $Rebuild,

    # Skip step 2 (descriptors and mappings)
    [Switch]
    $SkipSeed,

    # Skip step 3 (projections and the pg-boss database)
    [Switch]
    $SkipDeploy,

    # Service environment, relative to stack/
    [string]
    $EnvFile = "dms/.env.dms",

    # Client credentials, relative to stack/
    [string]
    $ClientsFile = "dms/.env.dms-clients",

    # The Ed-Fi API as seen from the DMS network (its discovery document names the token URL)
    [string]
    $DmsInternalUrl = "http://dms:8080",

    [int]
    $HealthTimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
Import-Module (Join-Path -Path $scriptDir -ChildPath "env-utility.psm1") -Force

function Resolve-StackPath {
    param([string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return Join-Path -Path $scriptDir -ChildPath $Path
}

function Invoke-Compose {
    param([string[]]$Arguments)
    & docker compose -f $composeFile @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker compose $($Arguments[0]) failed (exit code $LASTEXITCODE)."
    }
}

function Get-JobsDatabaseName {
    param([hashtable]$ServiceEnv)
    $config = $ServiceEnv["PG_BOSS_CONNECTION_CONFIG"]
    if ([string]::IsNullOrWhiteSpace($config)) {
        throw "PG_BOSS_CONNECTION_CONFIG is not set in $EnvFile."
    }
    $adminConnection = ($config | ConvertFrom-Json).adminConnection
    $match = [regex]::Match($adminConnection, '(?i)(?:^|;)\s*database\s*=\s*([^;]+)')
    if (-not $match.Success) {
        throw "PG_BOSS_CONNECTION_CONFIG in $EnvFile names no database."
    }
    return $match.Groups[1].Value.Trim()
}

$composeFile = Join-Path -Path $scriptDir -ChildPath "dms/docker-compose.yml"
$envFilePath = Resolve-StackPath $EnvFile
$clientsFilePath = Resolve-StackPath $ClientsFile
foreach ($file in @($envFilePath, $clientsFilePath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "$file was not found. Run setup-dms-clients.ps1 first."
    }
}
$serviceEnv = ReadValuesFromEnvFile -EnvironmentFile $envFilePath
$clients = ReadValuesFromEnvFile -EnvironmentFile $clientsFilePath

$network = if ($env:DMS_NETWORK) { $env:DMS_NETWORK } else { "dms" }
docker network inspect $network 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Docker network '$network' not found. Start the DMS stack first (bootstrap-local-dms.ps1 or start-local-dms.ps1)."
}

# The compose file reads the env file through this variable, so -EnvFile reaches every step
$env:ONEROSTER_DMS_ENV_FILE = $envFilePath

$image = if ($env:ONEROSTER_IMAGE) { $env:ONEROSTER_IMAGE } else { "edfi-oneroster:dms-local" }
docker image inspect $image 2>&1 | Out-Null
if ($Rebuild -or $LASTEXITCODE -ne 0) {
    Write-Host "Building $image..." -ForegroundColor Cyan
    Invoke-Compose @("build", "oneroster-dms")
}

if (-not $SkipSeed) {
    Write-Host "Seeding OneRoster descriptors and descriptor mappings..." -ForegroundColor Cyan
    # Passed by name only (-e NAME), so the values never appear on a command line
    $env:SEED_CLIENT_ID = $clients["DMS_SEEDER_KEY"]
    $env:SEED_CLIENT_SECRET = $clients["DMS_SEEDER_SECRET"]
    try {
        if ([string]::IsNullOrWhiteSpace($env:SEED_CLIENT_ID) -or [string]::IsNullOrWhiteSpace($env:SEED_CLIENT_SECRET)) {
            throw "DMS_SEEDER_KEY and DMS_SEEDER_SECRET must be set in $ClientsFile."
        }
        Invoke-Compose @("run", "--rm", "--no-deps", "-e", "SEED_CLIENT_ID", "-e", "SEED_CLIENT_SECRET",
            "oneroster-dms", "node", "standard/seed-descriptors.js", "--api-url", $DmsInternalUrl)
    }
    finally {
        Remove-Item Env:SEED_CLIENT_ID, Env:SEED_CLIENT_SECRET -ErrorAction SilentlyContinue
    }
}

if (-not $SkipDeploy) {
    if ($serviceEnv["DB_TYPE"] -eq "mssql") {
        Write-Host "Deploying the OneRoster projections (SQL Server)..." -ForegroundColor Cyan
        Invoke-Compose @("run", "--rm", "--no-deps", "oneroster-dms",
            "node", "standard/deploy-dms.js", "--from-cms")
    }
    else {
        $jobsDatabase = Get-JobsDatabaseName -ServiceEnv $serviceEnv
        Write-Host "Deploying the OneRoster projections and the pg-boss database ($jobsDatabase)..." -ForegroundColor Cyan
        Invoke-Compose @("run", "--rm", "--no-deps", "oneroster-dms",
            "node", "standard/deploy-dms.js", "--from-cms", "--jobs-database", $jobsDatabase)
    }
}

Write-Host "Starting the OneRoster service..." -ForegroundColor Cyan
Invoke-Compose @("up", "-d", "--no-build", "oneroster-dms")

$deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
do {
    Start-Sleep -Seconds 3
    $health = docker inspect --format "{{.State.Health.Status}}" oneroster-dms 2>$null
} until ($health -eq "healthy" -or (Get-Date) -gt $deadline)
if ($health -ne "healthy") {
    throw "oneroster-dms is '$health' after $HealthTimeoutSeconds seconds. Check: docker logs oneroster-dms"
}

$port = if ($env:ONEROSTER_DMS_PORT) { $env:ONEROSTER_DMS_PORT } else { "3200" }
Write-Host "OneRoster on DMS is up at http://localhost:$port" -ForegroundColor Green
