// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import express from 'express';
import { getDiscovery } from '../controllers/discoveryController.js';
import { isMultiTenancyEnabled, getTenantsConfig } from '../config/multi-tenancy-config.js';
import {
  getOdsContextConfig,
  validateContextValue
} from '../config/ods-context-config.js';
import { validateContextValueFromDatabase } from '../services/odsContextValidationService.js';
import { isDmsPlatform } from '../config/platform.js';
import { getRouteContextConfig } from '../config/route-context-config.js';
import { getDataStoreProvider } from '../platform/data-store-provider.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('Discovery');

/**
 * Middleware to validate ODS context value (e.g., school year)
 * Validates against both constraint and database
 * Only validates if context value is provided in the route
 */
async function validateContextMiddleware(req, res, next) {
  const contextConfig = getOdsContextConfig();

  if (!contextConfig) {
    // No context configured, skip validation
    return next();
  }

  const contextValue = req.params[contextConfig.parameterName];

  if (!contextValue) {
    // Context not provided in route, skip validation (allows partial URLs)
    return next();
  }

  // Validate against constraint (e.g., range, values, int, regex)
  if (!validateContextValue(contextValue, contextConfig)) {
    return res.status(404).json({
      error: 'The specified data could not be found.',
      title: 'Not Found',
      status: 404
    });
  }

  // Validate against database (OdsInstanceContexts table)
  const tenantId = req.params.tenantId || null;
  const dbType = process.env.DB_TYPE || 'postgres';

  try {
    const isValid = await validateContextValueFromDatabase(
      contextConfig.parameterName,
      contextValue,
      tenantId,
      dbType
    );

    if (!isValid) {
      return res.status(404).json({
        error: 'The specified data could not be found.',
        title: 'Not Found',
        status: 404
      });
    }

    next();
  } catch (error) {
    logger.error({ err: error }, 'Error validating context value');
    return res.status(404).json({
      error: 'The specified data could not be found.',
      title: 'Not Found',
      status: 404
    });
  }
}

/**
 * Middleware to validate tenant exists in configuration (multi-tenant mode only)
 * Only validates if tenant is provided in the route
 */
function validateTenantMiddleware(req, res, next) {
  if (!isMultiTenancyEnabled()) {
    return next();
  }

  const tenantId = req.params.tenantId;

  if (!tenantId) {
    // Tenant not provided in route, skip validation (allows root path)
    return next();
  }

  // Validate tenant exists in TENANTS_CONFIG
  const tenantsConfig = getTenantsConfig();
  if (tenantsConfig) {
    const normalizedTenantId = tenantId.toLowerCase();
    const tenantKey = Object.keys(tenantsConfig).find(
      key => key.toLowerCase() === normalizedTenantId
    );

    if (!tenantKey) {
      return res.status(404).json({
        error: 'The specified data could not be found.',
        title: 'Not Found',
        status: 404
      });
    }
  }

  next();
}

/**
 * DMS (multi-tenant): an unknown tenant is 404, as in DMS discovery. Route qualifier values are not
 * checked; DMS doesn't check them in discovery either.
 */
async function validateDmsTenantMiddleware(req, res, next) {
  try {
    if (await getDataStoreProvider().isTenant(req.params.tenantId)) {
      return next();
    }
    return res.status(404).json({
      error: 'The specified data could not be found.',
      title: 'Not Found',
      status: 404
    });
  } catch (error) {
    logger.error({ err: error }, 'Error validating tenant');
    return res.status(503).json({
      error: 'The service is temporarily unable to validate the tenant.',
      title: 'Service Unavailable',
      status: 503
    });
  }
}

/**
 * DMS: the root, the tenant, and each leading run of ROUTE_QUALIFIER_SEGMENTS after it, as DMS maps
 * its own discovery routes (/, /{tenant}, /{tenant}/{districtId}, /{tenant}/{districtId}/{schoolYear}).
 */
function mountDmsRoutes(router) {
  const multiTenancyEnabled = isMultiTenancyEnabled();
  const qualifiers = getRouteContextConfig()?.parameterNames || [];
  const leading = multiTenancyEnabled ? [':tenantId'] : [];
  const tenantCheck = multiTenancyEnabled ? [validateDmsTenantMiddleware] : [];

  router.get('/', getDiscovery);
  if (multiTenancyEnabled) {
    router.get('/:tenantId', ...tenantCheck, getDiscovery);
  }
  for (let count = 1; count <= qualifiers.length; count++) {
    const path = [...leading, ...qualifiers.slice(0, count).map(name => `:${name}`)].join('/');
    router.get(`/${path}`, ...tenantCheck, getDiscovery);
  }
}

/** The discovery routes for the configuration at the time of the call. */
export function createDiscoveryRouter() {
  const router = express.Router();

  if (isDmsPlatform()) {
    mountDmsRoutes(router);
    return router;
  }

  const multiTenancyEnabled = isMultiTenancyEnabled();
  const contextConfig = getOdsContextConfig();

  // Mount routes based on configuration
  if (multiTenancyEnabled && contextConfig) {
    // Multi-tenant with context: 3 routes
    // 1. Full path with both parameters
    router.get(`/:tenantId/:${contextConfig.parameterName}`, validateTenantMiddleware, validateContextMiddleware, getDiscovery);
    // 2. Tenant only
    router.get('/:tenantId', validateTenantMiddleware, getDiscovery);
    // 3. Root path
    router.get('/', getDiscovery);
  } else if (multiTenancyEnabled && !contextConfig) {
    // Multi-tenant without context: 2 routes
    // 1. Tenant path
    router.get('/:tenantId', validateTenantMiddleware, getDiscovery);
    // 2. Root path
    router.get('/', getDiscovery);
  } else if (!multiTenancyEnabled && contextConfig) {
    // Single-tenant with context: 2 routes
    // 1. Context path
    router.get(`/:${contextConfig.parameterName}`, validateContextMiddleware, getDiscovery);
    // 2. Root path
    router.get('/', getDiscovery);
  } else {
    // Single-tenant without context: 1 route
    router.get('/', getDiscovery);
  }

  return router;
}

export default createDiscoveryRouter();
