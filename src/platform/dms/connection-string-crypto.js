// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { createDecipheriv, hkdfSync } from 'node:crypto';

/**
 * Decrypt data-store connection strings stored by the DMS Configuration Service
 * (ConnectionStringEncryptionService / ConnectionStringDecryptionService, DMS 8.1).
 *
 * Key material: the UTF-8 bytes of the configured key, right-padded with '0' to 32 characters
 * and cut to 32 (CONFIGURATION_SERVICE_DATABASE_ENCRYPTION_KEY on the DMS side).
 *
 * Envelope (current): "EdFi.CS.Envelope" + version byte 1 | 12-byte nonce | 16-byte tag |
 * AES-256-GCM ciphertext of the PKCS7-padded UTF-8 string, with the 17-byte header as associated
 * data and a key of HKDF-SHA256(key material, no salt, "EdFi.ConnectionString.AES-256-GCM.v1").
 * Legacy: 16-byte IV | AES-256-CBC/PKCS7 ciphertext keyed with the key material directly.
 */

const MARKER = Buffer.from('EdFi.CS.Envelope', 'ascii');
const ENVELOPE_VERSION = 1;
const HEADER_LENGTH = MARKER.length + 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const BLOCK_LENGTH = 16;
const HKDF_INFO = 'EdFi.ConnectionString.AES-256-GCM.v1';

function keyMaterial(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('A connection-string encryption key is required');
  }
  return Buffer.from(key.padEnd(32, '0').slice(0, 32), 'utf8');
}

function stripPkcs7(padded) {
  const n = padded[padded.length - 1];
  if (!n || n > BLOCK_LENGTH || padded.length < n || !padded.subarray(padded.length - n).every(byte => byte === n)) {
    throw new Error('Invalid padding in decrypted connection string');
  }
  return padded.subarray(0, padded.length - n);
}

function decryptEnvelope(bytes, material) {
  const header = bytes.subarray(0, HEADER_LENGTH);
  if (header[HEADER_LENGTH - 1] !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported connection-string envelope version ${header[HEADER_LENGTH - 1]}`);
  }
  if (bytes.length < HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH + BLOCK_LENGTH) {
    throw new Error('Connection-string envelope is too short');
  }

  const gcmKey = Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), HKDF_INFO, 32));
  const nonce = bytes.subarray(HEADER_LENGTH, HEADER_LENGTH + NONCE_LENGTH);
  const tag = bytes.subarray(HEADER_LENGTH + NONCE_LENGTH, HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', gcmKey, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  decipher.setAutoPadding(false);

  // final() throws when the tag does not authenticate: a wrong key or a tampered value
  const padded = Buffer.concat([decipher.update(bytes.subarray(HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH)), decipher.final()]);
  return stripPkcs7(padded);
}

function decryptLegacy(bytes, material) {
  const decipher = createDecipheriv('aes-256-cbc', material, bytes.subarray(0, BLOCK_LENGTH));
  return Buffer.concat([decipher.update(bytes.subarray(BLOCK_LENGTH)), decipher.final()]);
}

/**
 * @param {string} value - Base64 ciphertext as returned by GET /v3/dataStores
 * @param {string} key - The Configuration Service connection-string encryption key
 * @param {Object} [options]
 * @param {boolean} [options.allowLegacy=true] - Accept the legacy AES-CBC format (DMS AllowLegacyConnectionStrings)
 * @returns {string} The plain-text connection string
 */
export function decryptConnectionString(value, key, { allowLegacy = true } = {}) {
  const material = keyMaterial(key);
  const bytes = Buffer.from(value, 'base64');
  let plain;

  if (bytes.length >= HEADER_LENGTH && bytes.subarray(0, MARKER.length).equals(MARKER)) {
    plain = decryptEnvelope(bytes, material);
  } else if (bytes.length >= 2 * BLOCK_LENGTH && bytes.length % BLOCK_LENGTH === 0) {
    if (!allowLegacy) {
      throw new Error('Legacy AES-CBC connection strings are not accepted');
    }
    plain = decryptLegacy(bytes, material);
  } else {
    throw new Error('Unrecognized encrypted connection-string format');
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(plain);
}

/**
 * Whether a configured connection string is plain text ("host=...;...") rather than Base64
 * ciphertext. Base64 has no ';', and a plain connection string always has one.
 */
export function isPlainConnectionString(value) {
  return typeof value === 'string' && value.includes(';');
}
