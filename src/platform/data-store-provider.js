// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { getPlatform, PLATFORMS } from '../config/platform.js';
import { getAdminConnectionString } from '../config/multi-tenancy-config.js';
import { getDmsDataStoreSettings } from '../config/dms-config.js';
import { odsInstanceService } from '../services/database/OdsInstanceService.js';
import { ConfigurationServiceClient } from './dms/configuration-service-client.js';
import { createConfigurationServiceDataStoreProvider, createStaticDataStoreProvider } from './dms/data-store-providers.js';
import { getLogger } from '../utils/logger.js';

/**
 * Data-store providers: where the connection string for the database a request reads comes from.
 *
 * A provider implements:
 *   resolveConnectionString({ tenantId, dataStoreId, dbType }) -> Promise<string> (plain text)
 *   destroy() -> Promise<void>, releasing any connections or caches the provider holds
 *
 * dataStoreId is the ODS instance ID on the ODS/API and the data store ID on DMS.
 */

const logger = getLogger('DataStoreProvider');

/**
 * ODS/API: connection strings from ODS_INSTANCES / a tenant's OdsInstances when configured,
 * otherwise from EdFi_Admin.dbo.OdsInstances, decrypted with ODS_CONNECTION_STRING_ENCRYPTION_KEY.
 * @param {Object} [deps] - Injectable for tests
 */
export function createEdFiAdminDataStoreProvider({
  instanceService = odsInstanceService,
  adminConnectionStringFor = getAdminConnectionString
} = {}) {
  return {
    name: 'edfiAdmin',

    async resolveConnectionString({ tenantId = null, dataStoreId, dbType }) {
      // EdFi_Admin connection string (tenant-specific or default)
      const adminConnectionString = adminConnectionStringFor(tenantId, dbType);
      logger.debug(`Resolving ODS connection via EdFi_Admin for OdsInstanceId: ${dataStoreId}`);

      return instanceService.resolveOdsConnectionString({
        adminConnectionString,
        dbType,
        odsInstanceId: dataStoreId,
        tenantId
      });
    },

    destroy() {
      return instanceService.destroy();
    }
  };
}

/**
 * DMS: the static DATA_STORES map when it is set, otherwise the Configuration Service
 * Management API (/v3/dataStores), which lists data stores, their route contexts and encrypted
 * connection strings.
 */
export function createDmsDataStoreProvider(env = process.env) {
  const settings = getDmsDataStoreSettings(env);

  if (settings.dataStores) {
    return createStaticDataStoreProvider({
      dataStores: settings.dataStores,
      encryptionKey: settings.encryptionKey,
      allowLegacy: settings.allowLegacy
    });
  }

  const client = new ConfigurationServiceClient({
    baseUrl: settings.configServiceUrl,
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    scope: settings.scope
  });
  return createConfigurationServiceDataStoreProvider({
    client,
    encryptionKey: settings.encryptionKey,
    allowLegacy: settings.allowLegacy,
    cacheSeconds: settings.cacheSeconds,
    useReadReplica: settings.useReadReplica
  });
}

let provider = null;
let providerPlatform = null;

/**
 * The data-store provider for the configured platform, created once and reused.
 * @param {string} [platform] - Defaults to the configured PLATFORM
 */
export function getDataStoreProvider(platform = getPlatform()) {
  if (provider && providerPlatform === platform) {
    return provider;
  }

  provider = platform === PLATFORMS.DMS ? createDmsDataStoreProvider() : createEdFiAdminDataStoreProvider();
  providerPlatform = platform;
  return provider;
}
