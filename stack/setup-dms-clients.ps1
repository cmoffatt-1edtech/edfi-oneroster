# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

<#
.SYNOPSIS
    Creates the OneRoster clients in a local Ed-Fi API v8 (DMS) Configuration Service and writes
    the env files for the OneRoster DMS stack.

.DESCRIPTION
    For the local DMS stack started from the Data-Management-Service repository
    (eng/docker-compose). Creates, through the Configuration Service API:

    - claim sets OneRoster-ReadOnly (roster + demographics scopes) and OneRoster-Core (roster-core
      scope). They grant no Ed-Fi resources, so OneRoster clients can't read the Ed-Fi API;
    - the vendor "1EdTech OneRoster (local)", namespace prefixes uri://ed-fi.org,uri://1edtech.org;
    - applications on the stack's data store: "OneRoster LEA" (ed-org 255901) and "OneRoster School"
      (255901107) on OneRoster-ReadOnly, "OneRoster LEA Core" (255901) on OneRoster-Core, and
      "OneRoster Seeder" (255901) on the built-in SeedLoader claim set, which
      standard/seed-descriptors.js uses to post the OneRoster descriptors.

    Then writes two git-ignored files next to the DMS compose file:

    - dms/.env.dms-clients: application keys and secrets and the stack URLs, as DMS_* variables.
      start-dms-services.ps1, the Bruno DMS environment and tests/compare-api.js ods-vs-dms read it.
    - dms/.env.dms: the service environment, from dms/.env.dms.5.2.0.example with the Configuration
      Service read-only secret, the connection-string encryption key and the PostgreSQL password
      filled in. An existing file is kept unless -Force is given.

    For a DMS stack on SQL Server (bootstrap-local-dms.ps1 -DatabaseEngine mssql), pass
    -DatabaseEngine mssql: the service environment comes from dms/.env.dms.5.2.0.mssql.example
    (DB_TYPE=mssql, no pg-boss) and needs no database password. -ClientsFile and -EnvFile keep the
    files of each engine's stack apart; give start-dms-services.ps1 the same two paths.

    Idempotent: existing claim sets, vendor and applications are reused, and credentials already in
    dms/.env.dms-clients are kept. If an application exists but its credentials are not in the
    file, rerun with -ResetMissingCredentials to rotate them.

    An existing application whose claim set or education organization differs from the ones above
    is updated to match, and the change is printed. One bound to a data store other than the
    requested one stops the script before anything is written: the Configuration Service binds
    data stores to API clients, which this script doesn't change.

    DMS caches claim sets for 10 minutes, so after creating a claim set the script restarts the DMS
    container (-DmsContainer, default ed-fi-api). -NoRestart skips that.

    The pg-boss database (oneroster_jobs) is created by start-dms-services.ps1, which has the
    data-store connection.

    Secrets are read from the DMS stack's .env file and never printed.

.EXAMPLE
    pwsh ./setup-dms-clients.ps1 -DmsComposeDir ~/src/Data-Management-Service/eng/docker-compose

.EXAMPLE
    pwsh ./setup-dms-clients.ps1 -DmsComposeDir ../../Data-Management-Service/eng/docker-compose -ResetMissingCredentials
    Rotates the credentials of applications that exist in CMS but are missing from dms/.env.dms-clients.
#>

param(
    # The DMS repository's eng/docker-compose directory (reads its .env). Or DMS_COMPOSE_DIR.
    [string]
    $DmsComposeDir = $env:DMS_COMPOSE_DIR,

    # Configuration Service and DMS URLs from the host
    [string]
    $CmsUrl = "http://localhost:8081",

    [string]
    $DmsUrl = "http://localhost:8080",

    # Where the OneRoster DMS service will answer (written to dms/.env.dms-clients for the tests)
    [string]
    $OneRosterUrl = "http://localhost:3200",

    [long]
    $LeaId = 255901,

    [long]
    $SchoolId = 255901107,

    [string]
    $VendorName = "1EdTech OneRoster (local)",

    # Data store for the applications. 0 means the only data store CMS lists.
    [long]
    $DataStoreId = 0,

    # The CMS client the service uses to read data stores. The DMS stack scripts create this one.
    [string]
    $CmsReadOnlyClientId = "CMSAuthMetadataReadOnlyAccess",

    # Its secret. When empty, the DMS stack's default is read from setup-openiddict.ps1.
    [string]
    $CmsReadOnlyClientSecret = $env:CMS_READONLY_CLIENT_SECRET,

    # The DMS stack's database engine, as bootstrap-local-dms.ps1 -DatabaseEngine
    [ValidateSet("postgresql", "mssql")]
    [string]
    $DatabaseEngine = "postgresql",

    # Default: dms/.env.dms.5.2.0.example, or dms/.env.dms.5.2.0.mssql.example for mssql
    [string]
    $ServiceEnvExample,

    # Client credentials to write, relative to stack/
    [string]
    $ClientsFile = "dms/.env.dms-clients",

    # Service environment to write, relative to stack/
    [string]
    $EnvFile = "dms/.env.dms",

    [string]
    $DmsContainer = "ed-fi-api",

    # Don't restart DMS after creating a claim set
    [Switch]
    $NoRestart,

    # Rotate the credentials of existing applications that are missing from dms/.env.dms-clients
    [Switch]
    $ResetMissingCredentials,

    # Rewrite dms/.env.dms even if it exists
    [Switch]
    $Force
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if (-not $scriptDir) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
Import-Module (Join-Path -Path $scriptDir -ChildPath "env-utility.psm1") -Force

$readOnlyClaimSet = "OneRoster-ReadOnly"
$coreClaimSet = "OneRoster-Core"
$seedClaimSet = "SeedLoader"
$namespacePrefixes = "uri://ed-fi.org,uri://1edtech.org"

# Applications to create: name, education organization, claim set, variable prefix in .env.dms-clients
$applications = @(
    @{ Name = "OneRoster LEA"; EdOrgId = $LeaId; ClaimSet = $readOnlyClaimSet; Prefix = "DMS_LEA" },
    @{ Name = "OneRoster School"; EdOrgId = $SchoolId; ClaimSet = $readOnlyClaimSet; Prefix = "DMS_SCHOOL" },
    @{ Name = "OneRoster LEA Core"; EdOrgId = $LeaId; ClaimSet = $coreClaimSet; Prefix = "DMS_CORE" },
    @{ Name = "OneRoster Seeder"; EdOrgId = $LeaId; ClaimSet = $seedClaimSet; Prefix = "DMS_SEEDER" }
)

function Resolve-StackPath {
    param([string]$Path)
    if ([System.IO.Path]::IsPathRooted($Path)) { return $Path }
    return Join-Path -Path $scriptDir -ChildPath $Path
}

function Get-RequiredValue {
    param([hashtable]$Values, [string]$Name, [string]$Source)
    $value = $Values[$Name]
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Name is not set in $Source."
    }
    return $value
}

function Get-CmsToken {
    param([string]$ClientId, [string]$ClientSecret, [string]$Scope)
    $body = @{
        grant_type    = "client_credentials"
        client_id     = $ClientId
        client_secret = $ClientSecret
        scope         = $Scope
    }
    try {
        $response = Invoke-RestMethod -Method Post -Uri "$CmsUrl/connect/token" -Body $body -ContentType "application/x-www-form-urlencoded"
    }
    catch {
        $status = $_.Exception.Response.StatusCode.value__
        throw "The Configuration Service refused a token for client '$ClientId' (HTTP $status). Check its credentials."
    }
    return $response.access_token
}

function Invoke-Cms {
    param([string]$Method = "Get", [string]$Path, $Body)
    $params = @{
        Method  = $Method
        Uri     = "$CmsUrl$Path"
        Headers = @{ Authorization = "Bearer $script:adminToken" }
    }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 5 -Compress)
        $params.ContentType = "application/json"
    }
    try {
        # Invoke-RestMethod emits a JSON array as one object; assigning and returning it unrolls
        # the array so Where-Object sees each element
        $result = Invoke-RestMethod @params
        return $result
    }
    catch {
        $status = $_.Exception.Response.StatusCode.value__
        throw "Configuration Service $Method $Path failed (HTTP $status): $($_.ErrorDetails.Message)"
    }
}

function Set-OwnerOnlyFile {
    param([string]$Path)
    # Create the file empty and restrict it before any secret is written to it
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType File -Path $Path | Out-Null
    }
    if (-not $IsWindows) {
        [System.IO.File]::SetUnixFileMode($Path, [System.IO.UnixFileMode]"UserRead, UserWrite")
    }
}

function Format-EnvValue {
    param([string]$Name, [string]$Value)
    # Single quotes keep $, ! and # literal for docker compose, bash and env-utility.psm1
    if ($Value.Contains("'")) {
        throw "$Name contains a single quote, which the env file format here can't hold."
    }
    return "$Name='$Value'"
}

# --- Inputs from the DMS stack ---------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($DmsComposeDir)) {
    throw "Set -DmsComposeDir (or DMS_COMPOSE_DIR) to the Data-Management-Service eng/docker-compose directory."
}
$dmsEnvFile = Join-Path -Path $DmsComposeDir -ChildPath ".env"
if (-not (Test-Path -LiteralPath $dmsEnvFile -PathType Leaf)) {
    throw "DMS stack env file not found: $dmsEnvFile. Start the DMS stack first (bootstrap-local-dms.ps1)."
}
$dmsEnv = ReadValuesFromEnvFile -EnvironmentFile $dmsEnvFile
$adminClientId = Get-RequiredValue $dmsEnv "CONFIGURATION_SERVICE_IDENTITY_CLIENT_ID" $dmsEnvFile
$adminClientSecret = Get-RequiredValue $dmsEnv "CONFIGURATION_SERVICE_IDENTITY_CLIENT_SECRET" $dmsEnvFile
$encryptionKey = Get-RequiredValue $dmsEnv "CONFIGURATION_SERVICE_DATABASE_ENCRYPTION_KEY" $dmsEnvFile
# pg-boss runs only on PostgreSQL; on SQL Server the SQL Server Agent refreshes the projections
$postgresPassword = if ($DatabaseEngine -eq "postgresql") { Get-RequiredValue $dmsEnv "POSTGRES_PASSWORD" $dmsEnvFile } else { $null }
if ([string]::IsNullOrWhiteSpace($ServiceEnvExample)) {
    $ServiceEnvExample = if ($DatabaseEngine -eq "mssql") { "dms/.env.dms.5.2.0.mssql.example" } else { "dms/.env.dms.5.2.0.example" }
}

if ([string]::IsNullOrWhiteSpace($CmsReadOnlyClientSecret)) {
    # The DMS stack registers the read-only client with setup-openiddict.ps1's default secret
    $openIddictScript = Join-Path -Path $DmsComposeDir -ChildPath "setup-openiddict.ps1"
    $match = $null
    if (Test-Path -LiteralPath $openIddictScript) {
        $match = Select-String -LiteralPath $openIddictScript -Pattern '\$NewClientSecret\s*=\s*"([^"]+)"' | Select-Object -First 1
    }
    if (-not $match) {
        throw "Set -CmsReadOnlyClientSecret (or CMS_READONLY_CLIENT_SECRET): the default could not be read from $openIddictScript."
    }
    $CmsReadOnlyClientSecret = $match.Matches[0].Groups[1].Value
}

$clientsFile = Resolve-StackPath $ClientsFile
$serviceEnvFile = Resolve-StackPath $EnvFile
$serviceEnvExample = Resolve-StackPath $ServiceEnvExample

# --- Configuration Service objects -----------------------------------------------------------

$script:adminToken = Get-CmsToken -ClientId $adminClientId -ClientSecret $adminClientSecret -Scope "edfi_admin_api/full_access"
# Fail now, not at service startup, if the read-only client the service uses doesn't work
Get-CmsToken -ClientId $CmsReadOnlyClientId -ClientSecret $CmsReadOnlyClientSecret -Scope "edfi_admin_api/authMetadata_readonly_access" | Out-Null

$dataStores = @(Invoke-Cms -Path "/v3/dataStores")
if ($DataStoreId -eq 0) {
    if ($dataStores.Count -ne 1) {
        throw "The Configuration Service lists $($dataStores.Count) data stores; pick one with -DataStoreId."
    }
    $DataStoreId = $dataStores[0].id
}
elseif (-not ($dataStores | Where-Object { $_.id -eq $DataStoreId })) {
    throw "Data store $DataStoreId is not in the Configuration Service."
}

$createdClaimSets = @()
$existingClaimSets = @(Invoke-Cms -Path "/v3/claimSets" | ForEach-Object { $_.claimSetName })
foreach ($claimSet in @($readOnlyClaimSet, $coreClaimSet)) {
    if ($existingClaimSets -notcontains $claimSet) {
        Invoke-Cms -Method Post -Path "/v3/claimSets" -Body @{ claimSetName = $claimSet } | Out-Null
        $createdClaimSets += $claimSet
        Write-Host "Created claim set $claimSet"
    }
}
if ($existingClaimSets -notcontains $seedClaimSet) {
    throw "The built-in $seedClaimSet claim set is missing from the Configuration Service."
}

$vendor = Invoke-Cms -Path "/v3/vendors" | Where-Object { $_.company -eq $VendorName } | Select-Object -First 1
if (-not $vendor) {
    Invoke-Cms -Method Post -Path "/v3/vendors" -Body @{
        company             = $VendorName
        contactName         = "OneRoster local"
        contactEmailAddress = "oneroster-local@example.org"
        namespacePrefixes   = $namespacePrefixes
    } | Out-Null
    $vendor = Invoke-Cms -Path "/v3/vendors" | Where-Object { $_.company -eq $VendorName } | Select-Object -First 1
    Write-Host "Created vendor $VendorName"
}

$existingClients = @{}
if (Test-Path -LiteralPath $clientsFile) {
    $existingClients = ReadValuesFromEnvFile -EnvironmentFile $clientsFile
}

$vendorApplications = @(Invoke-Cms -Path "/v3/vendors/$($vendor.id)/applications")
foreach ($app in $applications) {
    $app.Existing = $vendorApplications | Where-Object { $_.applicationName -eq $app.Name } | Select-Object -First 1
}

# CMS binds data stores to an application's API clients, which this script doesn't change. Check
# every existing application before creating, updating or writing anything.
foreach ($app in $applications | Where-Object { $_.Existing }) {
    $boundDataStores = @($app.Existing.dataStoreIds | Where-Object { $null -ne $_ })
    if ($boundDataStores.Count -ne 1 -or $boundDataStores[0] -ne $DataStoreId) {
        $bound = if ($boundDataStores.Count -gt 0) { $boundDataStores -join ", " } else { "none" }
        throw "Application '$($app.Name)' is on data store(s) $bound, not $DataStoreId. Pick that data store with -DataStoreId, or delete the application in the Configuration Service and rerun."
    }
}

$credentials = [ordered]@{}
foreach ($app in $applications) {
    $existing = $app.Existing
    $keyName = "$($app.Prefix)_KEY"
    $secretName = "$($app.Prefix)_SECRET"

    if ($existing) {
        # Bring the claim set and education organization back to what this script sets
        $edOrgIds = @($existing.educationOrganizationIds | Where-Object { $null -ne $_ })
        if ($existing.claimSetName -ne $app.ClaimSet -or $edOrgIds.Count -ne 1 -or $edOrgIds[0] -ne $app.EdOrgId) {
            Invoke-Cms -Method Put -Path "/v3/applications/$($existing.id)" -Body @{
                id                       = $existing.id
                applicationName          = $existing.applicationName
                vendorId                 = $vendor.id
                claimSetName             = $app.ClaimSet
                educationOrganizationIds = @($app.EdOrgId)
                profileIds               = @($existing.profileIds | Where-Object { $null -ne $_ })
            } | Out-Null
            $before = "$($existing.claimSetName), ed-org $(if ($edOrgIds.Count -gt 0) { $edOrgIds -join ',' } else { 'none' })"
            Write-Host "Updated application $($app.Name): $before -> $($app.ClaimSet), ed-org $($app.EdOrgId)" -ForegroundColor Yellow
        }
    }

    if (-not $existing) {
        $created = Invoke-Cms -Method Post -Path "/v3/applications" -Body @{
            applicationName          = $app.Name
            vendorId                 = $vendor.id
            claimSetName             = $app.ClaimSet
            educationOrganizationIds = @($app.EdOrgId)
            dataStoreIds             = @($DataStoreId)
        }
        $credentials[$keyName] = $created.key
        $credentials[$secretName] = $created.secret
        Write-Host "Created application $($app.Name) ($($app.ClaimSet), ed-org $($app.EdOrgId))"
    }
    elseif ($existingClients[$keyName] -and $existingClients[$secretName]) {
        $credentials[$keyName] = $existingClients[$keyName]
        $credentials[$secretName] = $existingClients[$secretName]
        Write-Host "Kept application $($app.Name)"
    }
    elseif ($ResetMissingCredentials) {
        $reset = Invoke-Cms -Method Put -Path "/v3/applications/$($existing.id)/reset-credential"
        $credentials[$keyName] = $reset.key
        $credentials[$secretName] = $reset.secret
        Write-Host "Reset the credentials of application $($app.Name)" -ForegroundColor Yellow
    }
    else {
        throw "Application '$($app.Name)' exists, but its credentials are not in $clientsFile. Rerun with -ResetMissingCredentials to rotate them."
    }
}

# --- Env files ---------------------------------------------------------------------------------

$clientLines = @(
    "# OneRoster on the local DMS stack. Written by stack/setup-dms-clients.ps1. Holds secrets: never commit or share.",
    (Format-EnvValue "DMS_API_URL" $DmsUrl),
    (Format-EnvValue "DMS_TOKEN_URL" "$DmsUrl/oauth/token"),
    (Format-EnvValue "DMS_ONEROSTER_URL" $OneRosterUrl),
    (Format-EnvValue "CMS_URL" $CmsUrl),
    (Format-EnvValue "DMS_DATA_STORE_ID" "$DataStoreId")
)
foreach ($entry in $credentials.GetEnumerator()) {
    $clientLines += Format-EnvValue $entry.Key $entry.Value
}
Set-OwnerOnlyFile -Path $clientsFile
Set-Content -LiteralPath $clientsFile -Value $clientLines
Write-Host "Wrote $clientsFile"

if ((Test-Path -LiteralPath $serviceEnvFile) -and -not $Force) {
    Write-Host "Kept $serviceEnvFile (rerun with -Force to rewrite it from $ServiceEnvExample)"
}
else {
    $text = Get-Content -LiteralPath $serviceEnvExample -Raw
    $text = $text.Replace("CONFIG_SERVICE_CLIENT_ID=CMSAuthMetadataReadOnlyAccess", (Format-EnvValue "CONFIG_SERVICE_CLIENT_ID" $CmsReadOnlyClientId))
    $text = $text.Replace("CONFIG_SERVICE_CLIENT_SECRET=<CMS read-only client secret>", (Format-EnvValue "CONFIG_SERVICE_CLIENT_SECRET" $CmsReadOnlyClientSecret))
    $text = $text.Replace("CONFIG_SERVICE_ENCRYPTION_KEY=<CONFIGURATION_SERVICE_DATABASE_ENCRYPTION_KEY from the DMS stack>", (Format-EnvValue "CONFIG_SERVICE_ENCRYPTION_KEY" $encryptionKey))
    if ($postgresPassword) {
        if ($postgresPassword.Contains('"') -or $postgresPassword.Contains(';') -or $postgresPassword.Contains("'")) {
            throw "POSTGRES_PASSWORD contains a character that can't go into PG_BOSS_CONNECTION_CONFIG unescaped."
        }
        $text = $text.Replace("password=<password>", "password=$postgresPassword")
    }

    $unfilled = @($text -split "`n" | Where-Object { -not $_.TrimStart().StartsWith("#") -and $_.Contains("<") })
    if ($unfilled.Count -gt 0) {
        throw "$ServiceEnvExample still has $($unfilled.Count) unfilled placeholder line(s) after substitution."
    }
    Set-OwnerOnlyFile -Path $serviceEnvFile
    Set-Content -LiteralPath $serviceEnvFile -Value $text.TrimEnd()
    Write-Host "Wrote $serviceEnvFile"
}

if ($createdClaimSets.Count -gt 0) {
    if ($NoRestart) {
        Write-Host "DMS caches claim sets for 10 minutes: restart $DmsContainer before using the new claim sets." -ForegroundColor Yellow
    }
    else {
        Write-Host "Restarting $DmsContainer so it loads the new claim sets..."
        docker restart $DmsContainer | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "docker restart $DmsContainer failed (exit code $LASTEXITCODE). Restart it before using the new claim sets."
        }
        $deadline = (Get-Date).AddSeconds(120)
        do {
            Start-Sleep -Seconds 3
            try { $ready = (Invoke-WebRequest -Uri $DmsUrl -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { $ready = $false }
        } until ($ready -or (Get-Date) -gt $deadline)
        if (-not $ready) {
            throw "$DmsContainer did not answer at $DmsUrl within 120 seconds after the restart."
        }
    }
}

Write-Host "Done: data store $DataStoreId, vendor $($vendor.id), $($applications.Count) applications." -ForegroundColor Green
