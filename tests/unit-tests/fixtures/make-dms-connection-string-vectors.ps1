# SPDX-License-Identifier: Apache-2.0
# Licensed to 1EdTech Consortium, Inc. under one or more agreements.
# 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
# See the LICENSE and NOTICES files in the project root for more information.

# Writes dms-connection-string-vectors.json: connection strings encrypted with .NET the way the
# DMS Configuration Service does (ConnectionStringEncryptionService.cs, dms-pre-8.1.0-beta2.3),
# so the Node decryptor is tested against an independent implementation. Test-only key and data.
#   pwsh tests/unit-tests/fixtures/make-dms-connection-string-vectors.ps1
$ErrorActionPreference = 'Stop'
$key = 'test-only-key-not-a-secret'
$plain = 'host=dms-postgresql;port=5432;username=oneroster;password=not-a-real-password;database=edfi_test'

$material = [Text.Encoding]::UTF8.GetBytes($key.PadRight(32, '0').Substring(0, 32))
$plainBytes = [Text.Encoding]::UTF8.GetBytes($plain)
$pad = 16 - ($plainBytes.Length % 16)
$padded = $plainBytes + ([byte[]](@([byte]$pad) * $pad))

# Envelope: "EdFi.CS.Envelope" + version 1 | nonce(12) | tag(16) | AES-256-GCM(PKCS7(plain)), AAD = header
$header = [Text.Encoding]::ASCII.GetBytes('EdFi.CS.Envelope') + [byte[]]@(1)
$gcmKey = [Security.Cryptography.HKDF]::DeriveKey([Security.Cryptography.HashAlgorithmName]::SHA256, $material, 32, [byte[]]@(), [Text.Encoding]::UTF8.GetBytes('EdFi.ConnectionString.AES-256-GCM.v1'))
$nonce = [byte[]]::new(12); [Security.Cryptography.RandomNumberGenerator]::Fill($nonce)
$cipher = [byte[]]::new($padded.Length); $tag = [byte[]]::new(16)
$gcm = [Security.Cryptography.AesGcm]::new($gcmKey, 16)
$gcm.Encrypt($nonce, $padded, $cipher, $tag, $header)
$envelope = [Convert]::ToBase64String($header + $nonce + $tag + $cipher)

# Legacy: IV(16) | AES-256-CBC/PKCS7(plain), keyed with the key material directly
$aes = [Security.Cryptography.Aes]::Create(); $aes.Key = $material
$iv = [byte[]]::new(16); [Security.Cryptography.RandomNumberGenerator]::Fill($iv)
$legacy = [Convert]::ToBase64String($iv + $aes.EncryptCbc($plainBytes, $iv, [Security.Cryptography.PaddingMode]::PKCS7))

[ordered]@{
  key = $key; plaintext = $plain; envelope = $envelope; legacy = $legacy
  generatedBy = ".NET $([Environment]::Version) via pwsh"
} | ConvertTo-Json | Set-Content -Path (Join-Path $PSScriptRoot 'dms-connection-string-vectors.json') -Encoding utf8NoBOM
