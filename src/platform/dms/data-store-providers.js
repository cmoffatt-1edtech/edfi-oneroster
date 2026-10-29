// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import crypto from 'crypto';
import { decryptConnectionString, isPlainConnectionString } from './connection-string-crypto.js';
import { ConfigurationServiceError } from './configuration-service-client.js';
import { getLogger } from '../../utils/logger.js';

/**
 * DMS data-store providers. Besides the shared resolveConnectionString / destroy contract
 * (src/platform/data-store-provider.js) they list data stores for routing:
 *   listDataStores(tenantId, { reload }) -> [{ id, name, contexts: { key: value }, connectionVersion, ... }]
 *   resolveRefreshConnectionString({ tenantId, dataStoreId }) -> the primary, when queries go to a
 *     read replica; null when the query connection is the primary
 *   isTenant(tenantId), isClientBoundToTenant(clientId, tenantId), checkHealth()
 */

const logger = getLogger('DmsDataStoreProvider');

export const DEFAULT_DATA_STORE_CACHE_SECONDS = 600;
const TENANT_CACHE_MS = 60_000;

export class DataStoreNotFoundError extends Error {
  constructor(dataStoreId) {
    super(`Data store ${dataStoreId} was not found`);
    this.name = 'DataStoreNotFoundError';
    this.code = 'DATA_STORE_NOT_FOUND';
  }
}

/**
 * A short digest of a data store's connection strings (as stored, so usually ciphertext). It
 * changes when the Configuration Service changes either one, which tells DatabaseServiceFactory to
 * replace the connection pools it built from the old values.
 */
export function connectionVersion(connectionString, readReplicaConnectionString) {
  return crypto.createHash('sha256')
    .update(`${connectionString || ''}\n${readReplicaConnectionString || ''}`)
    .digest('hex')
    .slice(0, 16);
}

/** Normalize a /v3/dataStores item. */
export function normalizeDataStore(item) {
  const connectionString = item.connectionString || null;
  const readReplicaConnectionString = (item.dataStoreDerivatives || [])
    .find(d => d.derivativeType === 'ReadReplica' && d.connectionString)?.connectionString || null;
  return {
    id: String(item.id),
    name: item.name,
    connectionString,
    contexts: Object.fromEntries((item.dataStoreContexts || []).map(c => [c.contextKey, c.contextValue])),
    readReplicaConnectionString,
    connectionVersion: connectionVersion(connectionString, readReplicaConnectionString)
  };
}

function tenantKey(tenantId) {
  return tenantId ? tenantId.toLowerCase() : '';
}

/**
 * Data stores, contexts and derivatives from the Configuration Service, cached per tenant.
 * @param {Object} options
 * @param {import('./configuration-service-client.js').ConfigurationServiceClient} options.client
 * @param {string} options.encryptionKey - CMS connection-string encryption key
 * @param {boolean} [options.allowLegacy=true]
 * @param {number} [options.cacheSeconds=600] - Data-store list TTL (DMS uses 600 s)
 * @param {boolean} [options.useReadReplica=false] - Query the ReadReplica derivative when there is one
 * @param {boolean} [options.multiTenancyEnabled=false] - CMS then needs a Tenant header on
 *   /v3/dataStores, so the health check reads /v3/tenants instead
 * @param {Function} [options.now]
 */
export function createConfigurationServiceDataStoreProvider({
  client,
  encryptionKey,
  allowLegacy = true,
  cacheSeconds = DEFAULT_DATA_STORE_CACHE_SECONDS,
  useReadReplica = false,
  multiTenancyEnabled = false,
  now = Date.now
}) {
  const dataStoreCache = new Map(); // tenant key -> { expiresAt, dataStores }
  let tenantCache = null; // { expiresAt, names: Set }

  async function listDataStores(tenantId = null, { reload = false } = {}) {
    const key = tenantKey(tenantId);
    const cached = dataStoreCache.get(key);
    if (!reload && cached && now() < cached.expiresAt) {
      return cached.dataStores;
    }
    const items = await client.getDataStores(tenantId);
    const dataStores = (items || []).map(normalizeDataStore);
    dataStoreCache.set(key, { expiresAt: now() + cacheSeconds * 1000, dataStores });
    logger.debug(`Loaded ${dataStores.length} data store(s)${tenantId ? ' for a tenant' : ''}`);
    return dataStores;
  }

  async function findDataStore(tenantId, dataStoreId) {
    const id = String(dataStoreId);
    let dataStore = (await listDataStores(tenantId)).find(ds => ds.id === id);
    if (!dataStore) {
      dataStore = (await listDataStores(tenantId, { reload: true })).find(ds => ds.id === id);
    }
    if (!dataStore) {
      throw new DataStoreNotFoundError(id);
    }
    return dataStore;
  }

  function decrypt(dataStore, encrypted) {
    if (!encrypted) {
      throw new Error(`Data store ${dataStore.id} has no connection string configured`);
    }
    return decryptConnectionString(encrypted, encryptionKey, { allowLegacy });
  }

  const queriesReplica = dataStore => Boolean(useReadReplica && dataStore.readReplicaConnectionString);

  return {
    name: 'configService',
    listDataStores,

    /** The connection queries use: the read replica when USE_READ_REPLICA is on and there is one. */
    async resolveConnectionString({ tenantId = null, dataStoreId }) {
      const dataStore = await findDataStore(tenantId, dataStoreId);
      return decrypt(dataStore, queriesReplica(dataStore) ? dataStore.readReplicaConnectionString : dataStore.connectionString);
    },

    /**
     * Materialized views are refreshed on the primary: a read replica (a hot standby) can't run
     * REFRESH, and it receives the refreshed views through replication.
     */
    async resolveRefreshConnectionString({ tenantId = null, dataStoreId }) {
      const dataStore = await findDataStore(tenantId, dataStoreId);
      return queriesReplica(dataStore) ? decrypt(dataStore, dataStore.connectionString) : null;
    },

    async isTenant(tenantId) {
      if (!tenantCache || now() >= tenantCache.expiresAt) {
        const tenants = await client.getTenants();
        tenantCache = {
          expiresAt: now() + TENANT_CACHE_MS,
          names: new Set((tenants || []).map(t => String(t.name).toLowerCase()))
        };
      }
      return tenantCache.names.has(tenantKey(tenantId));
    },

    /** DMS answers 401 when the client's application is not bound to the route tenant. */
    async isClientBoundToTenant(clientId, tenantId) {
      return (await client.getApiClient(clientId, tenantId)) !== null;
    },

    /**
     * Single tenant: read /v3/dataStores. Multi-tenant CMS answers 400 to that without a Tenant
     * header, so read /v3/tenants, which needs none and which tenant validation reads anyway.
     */
    async checkHealth() {
      if (!multiTenancyEnabled) {
        await client.getDataStores(null);
        return;
      }
      if ((await client.getTenants()) === null) {
        // CMS maps /v3/tenants only when its own multi-tenancy is on
        throw new ConfigurationServiceError('Configuration Service has no /v3/tenants: is it running multi-tenant?', 404);
      }
    },

    destroy() {
      dataStoreCache.clear();
      tenantCache = null;
      return Promise.resolve();
    }
  };
}

/**
 * Data stores from configuration, for deployments that inject connection strings from a secret
 * store instead of reading the Configuration Service. Same shape as ODS_INSTANCES, keyed by
 * data-store id:
 *   {"1": {"ConnectionString": "host=...;...", "ContextValueByKey": {"schoolYear": "2026"}}}
 * Connection strings may be plain text or CMS ciphertext (then encryptionKey is required).
 * Single tenant only.
 */
export function createStaticDataStoreProvider({ dataStores, encryptionKey = null, allowLegacy = true }) {
  const list = Object.entries(dataStores).map(([id, config]) => ({
    id: String(id),
    name: config.Name || `Data store ${id}`,
    connectionString: config.ConnectionString,
    contexts: { ...(config.ContextValueByKey || {}) },
    readReplicaConnectionString: null,
    connectionVersion: connectionVersion(config.ConnectionString, null)
  }));

  return {
    name: 'static',

    listDataStores() {
      return Promise.resolve(list);
    },

    async resolveConnectionString({ dataStoreId }) {
      const dataStore = list.find(ds => ds.id === String(dataStoreId));
      if (!dataStore) {
        throw new DataStoreNotFoundError(dataStoreId);
      }
      return isPlainConnectionString(dataStore.connectionString)
        ? dataStore.connectionString
        : decryptConnectionString(dataStore.connectionString, encryptionKey, { allowLegacy });
    },

    resolveRefreshConnectionString() {
      return Promise.resolve(null);
    },

    isTenant() {
      return Promise.resolve(false);
    },

    isClientBoundToTenant() {
      return Promise.resolve(false);
    },

    checkHealth() {
      return Promise.resolve();
    },

    destroy() {
      return Promise.resolve();
    }
  };
}
