// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { isMultiTenancyEnabled, getTenantsConfig } from '../config/multi-tenancy-config.js';
import { getOdsContextConfig } from '../config/ods-context-config.js';
import { getValidContextValues } from './odsContextValidationService.js';
import { isDmsPlatform } from '../config/platform.js';
import { getRouteContextConfig } from '../config/route-context-config.js';
import { getDataStoreProvider } from '../platform/data-store-provider.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('SwaggerServerBuilder');

/** One server whose URL ends in a selectable path, or the base URL alone when there's no choice. */
function selectionServer(baseUrl, label, values) {
  if (values.length === 0) {
    return [{ url: baseUrl }];
  }
  return [{
    url: `${baseUrl}/{${label}}`,
    variables: { [label]: { default: values[0], enum: values, description: label } }
  }];
}

/**
 * Ed-Fi API v8 (DMS): the route prefixes requests can use. Each is the tenant (multi-tenant) followed
 * by the values of ROUTE_QUALIFIER_SEGMENTS, in order, of a data store whose contexts have exactly
 * those keys (as dmsDataStoreMiddleware matches them). Data stores without a full set of qualifier
 * values can't be routed to and are left out.
 *
 * @param {string} baseUrl
 * @param {Object} options
 * @param {Object} options.provider - DMS data-store provider (listTenants, listDataStores)
 * @param {boolean} options.multiTenancyEnabled
 * @param {string[]} options.qualifierNames
 */
export async function buildDmsSwaggerServers(baseUrl, { provider, multiTenancyEnabled, qualifierNames }) {
  if (!multiTenancyEnabled && qualifierNames.length === 0) {
    return [{ url: baseUrl }];
  }

  try {
    const tenants = multiTenancyEnabled ? await provider.listTenants() : [null];
    const prefixes = new Set();
    for (const tenant of tenants) {
      if (qualifierNames.length === 0) {
        prefixes.add(tenant);
        continue;
      }
      for (const dataStore of await provider.listDataStores(tenant)) {
        const contexts = new Map(Object.entries(dataStore.contexts || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
        const values = qualifierNames.map(name => contexts.get(name.toLowerCase()));
        if (contexts.size === qualifierNames.length && values.every(value => value !== undefined && value !== '')) {
          prefixes.add([tenant, ...values].filter(part => part !== null).join('/'));
        }
      }
    }

    const label = !multiTenancyEnabled ? 'Context Selection'
      : qualifierNames.length === 0 ? 'Tenant Selection' : 'Tenant/Context Selection';
    return selectionServer(baseUrl, label, [...prefixes].sort());
  } catch (error) {
    logger.warn({ err: error }, 'Error listing tenants or data stores for the Swagger servers');
    return [{ url: baseUrl }];
  }
}

/**
 * Build Swagger servers array with dynamic tenant/context selection
 * @param {string} baseUrl - Base URL from request
 * @returns {Promise<Array>} Array of server configurations for Swagger
 */
export async function buildSwaggerServers(baseUrl) {
  if (isDmsPlatform()) {
    return buildDmsSwaggerServers(baseUrl, {
      provider: getDataStoreProvider(),
      multiTenancyEnabled: isMultiTenancyEnabled(),
      qualifierNames: getRouteContextConfig()?.parameterNames || []
    });
  }

  const multiTenancyEnabled = isMultiTenancyEnabled();
  const contextConfig = getOdsContextConfig();
  const dbType = process.env.DB_TYPE || 'postgres';

  // Case 1: Single-tenant without context - simple server
  if (!multiTenancyEnabled && !contextConfig) {
    return [{ url: baseUrl }];
  }

  // Case 2: Single-tenant with context - context selection dropdown
  if (!multiTenancyEnabled && contextConfig) {
    try {
      const contextValues = await getValidContextValues(contextConfig.parameterName, null, dbType);

      if (contextValues.length === 0) {
        // No context values found, return base URL
        return [{ url: baseUrl }];
      }

      return [{
        url: `${baseUrl}/{Context Selection}`,
        variables: {
          'Context Selection': {
            default: contextValues[0],
            enum: contextValues,
            description: 'Context Selection'
          }
        }
      }];
    } catch (error) {
      logger.warn({ err: error }, 'Error fetching context values');
      return [{ url: baseUrl }];
    }
  }

  // Case 3: Multi-tenant without context - tenant selection dropdown
  if (multiTenancyEnabled && !contextConfig) {
    const tenantsConfig = getTenantsConfig();
    if (!tenantsConfig) {
      return [{ url: baseUrl }];
    }

    const tenantIds = Object.keys(tenantsConfig);
    if (tenantIds.length === 0) {
      return [{ url: baseUrl }];
    }

    return [{
      url: `${baseUrl}/{Tenant Selection}`,
      variables: {
        'Tenant Selection': {
          default: tenantIds[0],
          enum: tenantIds,
          description: 'Tenant Selection'
        }
      }
    }];
  }

  // Case 4: Multi-tenant with context - combined tenant/context selection dropdown
  if (multiTenancyEnabled && contextConfig) {
    const tenantsConfig = getTenantsConfig();
    if (!tenantsConfig) {
      return [{ url: baseUrl }];
    }

    const tenantIds = Object.keys(tenantsConfig);
    if (tenantIds.length === 0) {
      return [{ url: baseUrl }];
    }

    try {
      // Build combined tenant/context values
      const combinedValues = [];

      for (const tenantId of tenantIds) {
        const contextValues = await getValidContextValues(contextConfig.parameterName, tenantId, dbType);

        if (contextValues.length > 0) {
          // Add tenant with each context value
          for (const contextValue of contextValues) {
            combinedValues.push(`${tenantId}/${contextValue}`);
          }
        } else {
          // Add tenant without context if no context values found
          combinedValues.push(tenantId);
        }
      }

      if (combinedValues.length === 0) {
        // No values found, just tenant selection
        return [{
          url: `${baseUrl}/{Tenant Selection}`,
          variables: {
            'Tenant Selection': {
              default: tenantIds[0],
              enum: tenantIds,
              description: 'Tenant Selection'
            }
          }
        }];
      }

      // Combined tenant/context selection
      return [{
        url: `${baseUrl}/{Tenant/Context Selection}`,
        variables: {
          'Tenant/Context Selection': {
            default: combinedValues[0],
            enum: combinedValues,
            description: 'Tenant/Context Selection'
          }
        }
      }];
    } catch (error) {
      logger.warn({ err: error }, 'Error fetching context values');
      // Fallback to just tenant selection
      return [{
        url: `${baseUrl}/{Tenant Selection}`,
        variables: {
          'Tenant Selection': {
            default: tenantIds[0],
            enum: tenantIds,
            description: 'Tenant Selection'
          }
        }
      }];
    }
  }

  // Fallback
  return [{ url: baseUrl }];
}
