#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// Phase 0 spike: decrypt a DMS Configuration Service data-store connection string.
// Mirrors ConnectionStringDecryptionService.cs (DMS dms-pre-8.1.0-beta2.3).
//
//   CMS_ENCRYPTION_KEY=... node tests/dms-spike/decrypt-connection-string.js <base64>
//   echo <base64> | CMS_ENCRYPTION_KEY=... node tests/dms-spike/decrypt-connection-string.js
//
// The key is CONFIGURATION_SERVICE_DATABASE_ENCRYPTION_KEY from the DMS stack env.
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

const MARKER = Buffer.from('EdFi.CS.Envelope', 'ascii');
const HEADER = 17, NONCE = 12, TAG = 16, OVERHEAD = HEADER + NONCE + TAG, BLOCK = 16;

export function decryptConnectionString(base64, key, { allowLegacy = true } = {}) {
  const material = Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf8');
  const b = Buffer.from(base64, 'base64');
  const isEnvelope = b.length % BLOCK === OVERHEAD % BLOCK || b.subarray(0, MARKER.length).equals(MARKER);
  let padded;
  if (isEnvelope) {
    const header = b.subarray(0, HEADER);
    if (!header.subarray(0, MARKER.length).equals(MARKER) || header[HEADER - 1] !== 1) throw new Error('unrecognized envelope');
    const gcmKey = Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), 'EdFi.ConnectionString.AES-256-GCM.v1', 32));
    const d = createDecipheriv('aes-256-gcm', gcmKey, b.subarray(HEADER, HEADER + NONCE));
    d.setAAD(header);
    d.setAuthTag(b.subarray(HEADER + NONCE, OVERHEAD));
    d.setAutoPadding(false);
    padded = Buffer.concat([d.update(b.subarray(OVERHEAD)), d.final()]);
    const n = padded[padded.length - 1]; // PKCS7 inside GCM: strip by hand
    if (n < 1 || n > BLOCK || !padded.subarray(padded.length - n).every((x) => x === n)) throw new Error('bad padding');
    padded = padded.subarray(0, padded.length - n);
  } else if (b.length >= 32 && b.length % BLOCK === 0) {
    if (!allowLegacy) throw new Error('legacy AES-CBC value rejected');
    const d = createDecipheriv('aes-256-cbc', material, b.subarray(0, 16)); // Node strips PKCS7
    padded = Buffer.concat([d.update(b.subarray(16)), d.final()]);
  } else {
    throw new Error(`invalid length ${b.length}`);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(padded);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.env.CMS_ENCRYPTION_KEY;
  if (!key) throw new Error('set CMS_ENCRYPTION_KEY');
  const input = (process.argv[2] ?? readFileSync(0, 'utf8')).trim();
  const text = decryptConnectionString(input, key);
  // Never print the password.
  console.log(process.env.SHOW_SECRET === '1' ? text : text.replace(/(password=)[^;]*/i, '$1***'));
}
