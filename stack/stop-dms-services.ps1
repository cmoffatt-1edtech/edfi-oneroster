# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

<#
.SYNOPSIS
    Stops the OneRoster service started by start-dms-services.ps1. The DMS stack keeps running.

.DESCRIPTION
    Stop it before wiping the DMS stack (bootstrap-local-dms.ps1 -d -v), which removes the
    Docker network the service is attached to. The projections and the pg-boss database live in
    the DMS data store and are not touched.

.EXAMPLE
    pwsh ./stop-dms-services.ps1

.EXAMPLE
    pwsh ./stop-dms-services.ps1 -Purge
    Also removes the locally built OneRoster image.
#>

param(
    # Also remove the image
    [Switch]
    $Purge,

    # Service environment, relative to stack/ (compose needs it to load the project)
    [string]
    $EnvFile = "dms/.env.dms"
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$envFilePath = if ([System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path -Path $scriptDir -ChildPath $EnvFile }
if (-not (Test-Path -LiteralPath $envFilePath -PathType Leaf)) {
    # Nothing secret is needed to stop the container; an empty file lets compose load the project
    $envFilePath = [System.IO.Path]::GetTempFileName()
    $temporaryEnvFile = $true
}
$env:ONEROSTER_DMS_ENV_FILE = $envFilePath

$composeArgs = @("compose", "-f", (Join-Path -Path $scriptDir -ChildPath "dms/docker-compose.yml"), "down", "--remove-orphans")
if ($Purge) {
    $composeArgs += @("--rmi", "all")
}

try {
    & docker @composeArgs
    $exitCode = $LASTEXITCODE
}
finally {
    if ($temporaryEnvFile) {
        Remove-Item -LiteralPath $envFilePath -ErrorAction SilentlyContinue
    }
}

# A wipe after a failed stop would remove the network under a running container
if ($exitCode -ne 0) {
    throw "docker compose down failed (exit code $exitCode); the OneRoster DMS service may still be running."
}

Write-Host "OneRoster DMS service stopped." -ForegroundColor Green
