// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { bootstrapAppSecretsIfNeeded } from '../../src/config/app-secrets-bootstrap.js';

const VARIABLES = [
  'APP_SECRETS_MODULE', 'PLATFORM', 'ODS_CONNECTION_STRING_ENCRYPTION_KEY', 'OAUTH2_PUBLIC_KEY_PEM', 'PG_BOSS_CONNECTION_CONFIG',
  'CONFIG_SERVICE_CLIENT_SECRET', 'CONFIG_SERVICE_ENCRYPTION_KEY', 'DATA_STORES'
];

describe('bootstrapAppSecretsIfNeeded', () => {
  let dir;
  let saved;
  let modules = 0;

  beforeEach(async () => {
    saved = Object.fromEntries(VARIABLES.map(name => [name, process.env[name]]));
    VARIABLES.forEach(name => delete process.env[name]);
    dir = await mkdtemp(path.join(os.tmpdir(), 'app-secrets-bootstrap-'));
  });

  afterEach(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** A plugin module that returns `secrets` (a fresh file each time, so the import isn't cached). */
  async function usePlugin(secrets) {
    const file = path.join(dir, `plugin-${++modules}.mjs`);
    await writeFile(file, `export async function loadAppSecrets() { return ${JSON.stringify(secrets)}; }\n`);
    process.env.APP_SECRETS_MODULE = file;
  }

  test('does nothing without APP_SECRETS_MODULE', async () => {
    await bootstrapAppSecretsIfNeeded();
    expect(process.env.ODS_CONNECTION_STRING_ENCRYPTION_KEY).toBeUndefined();
  });

  test('ODS/API: requires and sets the ODS key and the PEM, as before', async () => {
    await usePlugin({ odsConnectionStringEncryptionKey: ' k ', oauth2PublicKeyPem: 'pem', pgBossConnectionConfig: { adminConnection: 'host=x' } });
    await bootstrapAppSecretsIfNeeded();
    expect(process.env.ODS_CONNECTION_STRING_ENCRYPTION_KEY).toBe('k');
    expect(process.env.OAUTH2_PUBLIC_KEY_PEM).toBe('pem');
    expect(JSON.parse(process.env.PG_BOSS_CONNECTION_CONFIG)).toEqual({ adminConnection: 'host=x' });

    await usePlugin({ configServiceClientSecret: 's' });
    await expect(bootstrapAppSecretsIfNeeded()).rejects.toThrow('non-empty string odsConnectionStringEncryptionKey');
  });

  describe('PLATFORM=dms', () => {
    beforeEach(() => { process.env.PLATFORM = 'dms'; });

    test('sets the Configuration Service secret and key, and needs no ODS secret', async () => {
      await usePlugin({ configServiceClientSecret: 'secret ', configServiceEncryptionKey: 'key' });
      await bootstrapAppSecretsIfNeeded();
      expect(process.env.CONFIG_SERVICE_CLIENT_SECRET).toBe('secret');
      expect(process.env.CONFIG_SERVICE_ENCRYPTION_KEY).toBe('key');
      expect(process.env.ODS_CONNECTION_STRING_ENCRYPTION_KEY).toBeUndefined();
    });

    test('sets static data stores, with no encryption key needed', async () => {
      const dataStores = { 1: { ConnectionString: 'host=db;port=5432;database=x;username=u;password=p' } };
      await usePlugin({ dataStores });
      await bootstrapAppSecretsIfNeeded();
      expect(JSON.parse(process.env.DATA_STORES)).toEqual(dataStores);
      expect(process.env.CONFIG_SERVICE_ENCRYPTION_KEY).toBeUndefined();
    });

    test('rejects empty values and a plugin that returns nothing it knows', async () => {
      await usePlugin({ configServiceClientSecret: '  ' });
      await expect(bootstrapAppSecretsIfNeeded()).rejects.toThrow('configServiceClientSecret must be a non-empty string');
      await usePlugin({ dataStores: {} });
      await expect(bootstrapAppSecretsIfNeeded()).rejects.toThrow('dataStores must be a non-empty object');
      await usePlugin({ odsConnectionStringEncryptionKey: 'k', oauth2PublicKeyPem: 'pem' });
      await expect(bootstrapAppSecretsIfNeeded()).rejects.toThrow('With PLATFORM=dms, loadAppSecrets must return at least one of');
    });
  });
});
