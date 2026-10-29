// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect } from '@jest/globals';
import fs from 'fs';
import {
  normalizeDataStore,
  connectionVersion,
  createConfigurationServiceDataStoreProvider,
  createStaticDataStoreProvider,
  DataStoreNotFoundError
} from '../../src/platform/dms/data-store-providers.js';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/dms-connection-string-vectors.json', import.meta.url), 'utf8'));

// Shaped like GET /v3/dataStores (docs/design/dms-samples/cms-v3-dataStores.json)
const dataStore2026 = {
  id: 1, name: 'School Year 2026', dataStoreType: 'SchoolYear', provider: 'postgresql',
  connectionString: vectors.envelope,
  dataStoreContexts: [{ id: 1, dataStoreId: 1, contextKey: 'schoolYear', contextValue: '2026' }],
  dataStoreDerivatives: [{ id: 1, dataStoreId: 1, derivativeType: 'ReadReplica', connectionString: vectors.legacy }],
  tenantId: null
};

function createClient(stores = [dataStore2026]) {
  return {
    getDataStores: jest.fn(async () => stores),
    getTenants: jest.fn(async () => [{ id: 1, name: 'Tenant1' }]),
    getApiClient: jest.fn(async (clientId) => (clientId === 'bound' ? { clientId } : null))
  };
}

describe('DMS data-store providers', () => {
  test('normalizeDataStore keeps the id, contexts and read replica', () => {
    expect(normalizeDataStore(dataStore2026)).toEqual({
      id: '1',
      name: 'School Year 2026',
      connectionString: vectors.envelope,
      contexts: { schoolYear: '2026' },
      readReplicaConnectionString: vectors.legacy,
      connectionVersion: connectionVersion(vectors.envelope, vectors.legacy)
    });
  });

  test('the connection version changes with either connection string and only then', () => {
    const version = normalizeDataStore(dataStore2026).connectionVersion;
    const withDerivative = connectionString => ({
      ...dataStore2026,
      dataStoreDerivatives: [{ ...dataStore2026.dataStoreDerivatives[0], connectionString }]
    });

    expect(version).toMatch(/^[0-9a-f]{16}$/);
    expect(normalizeDataStore({ ...dataStore2026, dataStoreContexts: [] }).connectionVersion).toBe(version);
    expect(normalizeDataStore({ ...dataStore2026, connectionString: 'other' }).connectionVersion).not.toBe(version);
    expect(normalizeDataStore(withDerivative('other')).connectionVersion).not.toBe(version);
  });

  describe('Configuration Service', () => {
    test('caches the data-store list per tenant until it expires', async () => {
      const client = createClient();
      let clock = 0;
      const provider = createConfigurationServiceDataStoreProvider({ client, encryptionKey: vectors.key, cacheSeconds: 600, now: () => clock });

      await provider.listDataStores(null);
      await provider.listDataStores(null);
      await provider.listDataStores('Tenant1');
      expect(client.getDataStores).toHaveBeenCalledTimes(2);

      clock = 601_000;
      await provider.listDataStores(null);
      expect(client.getDataStores).toHaveBeenCalledTimes(3);
    });

    test('decrypts the primary connection string, or the read replica when asked', async () => {
      const primary = createConfigurationServiceDataStoreProvider({ client: createClient(), encryptionKey: vectors.key });
      const replica = createConfigurationServiceDataStoreProvider({ client: createClient(), encryptionKey: vectors.key, useReadReplica: true });

      await expect(primary.resolveConnectionString({ dataStoreId: 1 })).resolves.toBe(vectors.plaintext);
      await expect(replica.resolveConnectionString({ dataStoreId: '1' })).resolves.toBe(vectors.plaintext);
    });

    test('reloads once when the data store is not in the cache, then gives up', async () => {
      const client = createClient();
      const provider = createConfigurationServiceDataStoreProvider({ client, encryptionKey: vectors.key });

      await expect(provider.resolveConnectionString({ dataStoreId: 7 })).rejects.toBeInstanceOf(DataStoreNotFoundError);
      expect(client.getDataStores).toHaveBeenCalledTimes(2);
    });

    test('refuses legacy ciphertext when legacy connection strings are not allowed', async () => {
      const provider = createConfigurationServiceDataStoreProvider({
        client: createClient(), encryptionKey: vectors.key, allowLegacy: false, useReadReplica: true
      });
      await expect(provider.resolveConnectionString({ dataStoreId: 1 })).rejects.toThrow('Legacy AES-CBC');
    });

    test('knows the tenants (case-insensitively, cached) and the client bindings', async () => {
      const client = createClient();
      const provider = createConfigurationServiceDataStoreProvider({ client, encryptionKey: vectors.key });

      expect(await provider.isTenant('tenant1')).toBe(true);
      expect(await provider.isTenant('Tenant2')).toBe(false);
      expect(client.getTenants).toHaveBeenCalledTimes(1);
      expect(await provider.isClientBoundToTenant('bound', 'Tenant1')).toBe(true);
      expect(await provider.isClientBoundToTenant('other', 'Tenant1')).toBe(false);
      expect(client.getApiClient).toHaveBeenCalledWith('other', 'Tenant1');
    });

    // The primary is envelope ciphertext and the replica legacy ciphertext, so with legacy refused
    // only the primary decrypts: that shows which one each method picked.
    test('refreshes on the primary when queries go to the read replica', async () => {
      const replica = createConfigurationServiceDataStoreProvider({
        client: createClient(), encryptionKey: vectors.key, allowLegacy: false, useReadReplica: true
      });
      await expect(replica.resolveConnectionString({ dataStoreId: 1 })).rejects.toThrow('Legacy AES-CBC');
      await expect(replica.resolveRefreshConnectionString({ dataStoreId: 1 })).resolves.toBe(vectors.plaintext);
    });

    test('has no separate refresh connection when queries use the primary', async () => {
      const primary = createConfigurationServiceDataStoreProvider({ client: createClient(), encryptionKey: vectors.key });
      const noReplica = createConfigurationServiceDataStoreProvider({
        client: createClient([{ ...dataStore2026, dataStoreDerivatives: [] }]), encryptionKey: vectors.key, useReadReplica: true
      });
      await expect(primary.resolveRefreshConnectionString({ dataStoreId: 1 })).resolves.toBeNull();
      await expect(noReplica.resolveRefreshConnectionString({ dataStoreId: 1 })).resolves.toBeNull();
    });

    test('checks health through /v3/dataStores when single-tenant', async () => {
      const client = createClient();
      await createConfigurationServiceDataStoreProvider({ client, encryptionKey: vectors.key }).checkHealth();
      expect(client.getDataStores).toHaveBeenCalledWith(null);
      expect(client.getTenants).not.toHaveBeenCalled();
    });

    // Multi-tenant CMS answers 400 to /v3/dataStores without a Tenant header
    test('checks health through /v3/tenants when multi-tenant', async () => {
      const client = createClient();
      await createConfigurationServiceDataStoreProvider({ client, encryptionKey: vectors.key, multiTenancyEnabled: true }).checkHealth();
      expect(client.getTenants).toHaveBeenCalledTimes(1);
      expect(client.getDataStores).not.toHaveBeenCalled();
    });

    test('fails the multi-tenant health check when CMS has no /v3/tenants', async () => {
      const client = { ...createClient(), getTenants: jest.fn(async () => null) };
      const provider = createConfigurationServiceDataStoreProvider({ client, encryptionKey: vectors.key, multiTenancyEnabled: true });
      await expect(provider.checkHealth()).rejects.toThrow('is it running multi-tenant');
    });
  });

  describe('static DATA_STORES', () => {
    const provider = createStaticDataStoreProvider({
      encryptionKey: vectors.key,
      dataStores: {
        1: { ConnectionString: 'host=localhost;port=5435;database=edfi_datamanagementservice', ContextValueByKey: { schoolYear: '2026' } },
        2: { ConnectionString: vectors.envelope }
      }
    });

    test('lists the configured data stores with their contexts', async () => {
      const list = await provider.listDataStores();
      expect(list.map(ds => [ds.id, ds.contexts])).toEqual([['1', { schoolYear: '2026' }], ['2', {}]]);
    });

    test('uses plain connection strings as they are and decrypts ciphertext', async () => {
      await expect(provider.resolveConnectionString({ dataStoreId: 1 })).resolves.toBe('host=localhost;port=5435;database=edfi_datamanagementservice');
      await expect(provider.resolveConnectionString({ dataStoreId: 2 })).resolves.toBe(vectors.plaintext);
      await expect(provider.resolveConnectionString({ dataStoreId: 3 })).rejects.toBeInstanceOf(DataStoreNotFoundError);
    });

    test('refreshes on the query connection and carries a connection version', async () => {
      await expect(provider.resolveRefreshConnectionString({ dataStoreId: 1 })).resolves.toBeNull();
      const [first, second] = await provider.listDataStores();
      expect(first.connectionVersion).toMatch(/^[0-9a-f]{16}$/);
      expect(first.connectionVersion).not.toBe(second.connectionVersion);
    });
  });
});
