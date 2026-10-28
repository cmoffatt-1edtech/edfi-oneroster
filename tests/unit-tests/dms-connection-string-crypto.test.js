// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import fs from 'fs';
import { decryptConnectionString, isPlainConnectionString } from '../../src/platform/dms/connection-string-crypto.js';

// Encrypted with .NET by fixtures/make-dms-connection-string-vectors.ps1 (test-only key and data)
const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/dms-connection-string-vectors.json', import.meta.url), 'utf8'));

describe('DMS connection-string decryption', () => {
  test('decrypts the AES-256-GCM envelope written by .NET', () => {
    expect(decryptConnectionString(vectors.envelope, vectors.key)).toBe(vectors.plaintext);
  });

  test('decrypts the legacy AES-256-CBC format written by .NET', () => {
    expect(decryptConnectionString(vectors.legacy, vectors.key)).toBe(vectors.plaintext);
  });

  test('refuses the legacy format when it is not allowed', () => {
    expect(() => decryptConnectionString(vectors.legacy, vectors.key, { allowLegacy: false }))
      .toThrow('Legacy AES-CBC connection strings are not accepted');
    expect(decryptConnectionString(vectors.envelope, vectors.key, { allowLegacy: false })).toBe(vectors.plaintext);
  });

  test('fails authentication with the wrong key', () => {
    expect(() => decryptConnectionString(vectors.envelope, 'another-key')).toThrow();
  });

  test('fails authentication when the ciphertext was altered', () => {
    const bytes = Buffer.from(vectors.envelope, 'base64');
    bytes[bytes.length - 1] ^= 0x01;
    expect(() => decryptConnectionString(bytes.toString('base64'), vectors.key)).toThrow();
  });

  test('rejects an unknown envelope version', () => {
    const bytes = Buffer.from(vectors.envelope, 'base64');
    bytes[16] = 2;
    expect(() => decryptConnectionString(bytes.toString('base64'), vectors.key)).toThrow('Unsupported connection-string envelope version 2');
  });

  test('rejects values in neither format, and a missing key', () => {
    expect(() => decryptConnectionString(Buffer.from('short').toString('base64'), vectors.key)).toThrow('Unrecognized encrypted connection-string format');
    expect(() => decryptConnectionString(vectors.envelope, '')).toThrow('A connection-string encryption key is required');
  });

  test('tells plain connection strings from ciphertext', () => {
    expect(isPlainConnectionString(vectors.plaintext)).toBe(true);
    expect(isPlainConnectionString(vectors.envelope)).toBe(false);
    expect(isPlainConnectionString(undefined)).toBe(false);
  });
});
