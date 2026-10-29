// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { dmsClaimsProfile } from '../platform/claims-profile.js';
import { getLogger } from '../utils/logger.js';

/**
 * Ed-Fi API v8 (DMS) request flow, in place of the ODS tenant and instance middleware.
 * Mirrors DMS's own routing (ValidateClientTenantBindingMiddleware, ResolveDataStoreMiddleware):
 *
 * 1. Multi-tenant: the tenant is the first path segment. An unknown tenant is 404; a client whose
 *    application is not bound to the tenant is 401 (checked through the Configuration Service).
 * 2. A token with no dataStoreIds is 403.
 * 3. Of the client's data stores, exactly one must match the route qualifiers: same context keys,
 *    values compared case-insensitively; with no qualifiers, a data store with no contexts. None
 *    is 404 (after one reload from the Configuration Service); more than one is 400.
 *
 * On success it sets req.tenantId, req.odsInstanceId (the data-store id) and req.odsCacheKey,
 * which the controller and DatabaseServiceFactory use on both platforms, and
 * req.odsConnectionVersion (DMS only), so a connection changed in the Configuration Service
 * replaces the cached service.
 */

const logger = getLogger('DmsDataStoreMiddleware');

function failure(res, status, description) {
  return res.status(status).json({
    imsx_codeMajor: 'failure',
    imsx_severity: 'error',
    imsx_description: description
  });
}

/** DMS RouteContextMatcher: same keys (case-insensitive), values equal ignoring case. */
export function isRouteContextMatch(contexts, qualifiers) {
  const lower = object => new Map(Object.entries(object).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  const contextMap = lower(contexts);
  const qualifierMap = lower(qualifiers);

  if (contextMap.size !== qualifierMap.size) return false;
  for (const [key, value] of contextMap) {
    if (qualifierMap.get(key) !== value) return false;
  }
  return true;
}

/** The data stores among the authorized ones whose contexts match the route qualifiers. */
export function matchDataStores(dataStores, authorizedIds, qualifiers) {
  const authorized = new Set(authorizedIds.map(String));
  return dataStores.filter(ds => authorized.has(String(ds.id)) && isRouteContextMatch(ds.contexts, qualifiers));
}

/**
 * @param {Object} options
 * @param {Object} options.provider - DMS data-store provider (src/platform/dms/data-store-providers.js)
 * @param {boolean} options.multiTenancyEnabled
 * @param {Object|null} options.routeContext - from getRouteContextConfig(): { parameterNames }
 */
export function createDmsDataStoreMiddleware({ provider, multiTenancyEnabled, routeContext }) {
  const qualifierNames = routeContext?.parameterNames || [];

  return async function dmsDataStoreMiddleware(req, res, next) {
    const payload = req.auth?.payload;
    let tenantId = null;

    try {
      if (multiTenancyEnabled) {
        tenantId = req.params?.tenantId || null;
        if (!tenantId || !(await provider.isTenant(tenantId))) {
          logger.warn('Unknown or missing tenant in route');
          return failure(res, 404, 'The requested resource was not found.');
        }
        if (!payload?.client_id || !(await provider.isClientBoundToTenant(payload.client_id, tenantId))) {
          logger.warn('Client is not bound to the requested tenant');
          return failure(res, 401, 'Not authorized to access the requested resource.');
        }
      }

      const authorizedIds = dmsClaimsProfile.getDataStoreIds(payload);
      if (authorizedIds.length === 0) {
        logger.warn('Token authorizes no data stores');
        return failure(res, 403, 'No data stores are authorized for this client.');
      }

      const qualifiers = Object.fromEntries(qualifierNames.map(name => [name, req.params?.[name]]));
      let matches = matchDataStores(await provider.listDataStores(tenantId), authorizedIds, qualifiers);
      if (matches.length === 0) {
        matches = matchDataStores(await provider.listDataStores(tenantId, { reload: true }), authorizedIds, qualifiers);
      }

      if (matches.length > 1) {
        logger.warn(`Route qualifiers match ${matches.length} authorized data stores`);
        return failure(res, 400, 'More than one data store matches the request route.');
      }
      if (matches.length === 0) {
        logger.warn('No authorized data store matches the route qualifiers');
        return failure(res, 404, 'The specified data could not be found.');
      }

      const dataStoreId = matches[0].id;
      req.tenantId = tenantId;
      req.odsInstanceId = dataStoreId;
      req.odsCacheKey = tenantId ? `tenant-${tenantId}-datastore-${dataStoreId}` : `datastore-${dataStoreId}`;
      req.odsConnectionVersion = matches[0].connectionVersion || null;
      logger.debug(`Resolved data store ${dataStoreId}`);
      next();
    } catch (error) {
      logger.error({ err: error }, 'Data-store resolution failed');
      return failure(res, 503, 'The service is temporarily unable to resolve the data store.');
    }
  };
}
