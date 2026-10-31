// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Environment Variable Validator
 * Validates required environment variables before application startup
 */

import { RECOMMENDED_MAX_PAGE_SIZE, parseMaxPageSize } from './paginationLimits.js';
import { VALID_LEVELS as VALID_LOG_LEVELS, getLogger } from './logger.js';
import { isSwaggerUiEnabled, isOpenApiMetadataEnabled } from '../config/api-docs.js';
import { parsePlatform, PLATFORMS } from '../config/platform.js';
import { parseRouteQualifierSegments } from '../config/route-context-config.js';
import { dmsScopeWarnings, dmsTransportWarnings, validateDmsSettings } from '../config/dms-config.js';

const logger = getLogger('EnvValidator');

/**
 * Validates all required environment variables
 * @returns {Object} - { isValid: boolean, errors: string[] }
 */
export function validateEnvironmentVariables() {
  const errors = [];

  // PLATFORM: If set, must be "ods" or "dms", matched case-insensitively. If unset, the service
  // targets the Ed-Fi ODS/API. An unrecognised value is checked as "ods" below so every other
  // error is still reported.
  const parsedPlatform = parsePlatform(process.env.PLATFORM);
  if (!parsedPlatform) {
    errors.push(`PLATFORM must be one of: ${Object.values(PLATFORMS).join(', ')} if set`);
  }
  const isOdsPlatform = (parsedPlatform || PLATFORMS.ODS) === PLATFORMS.ODS;

  // PORT: If set, must be a valid integer in range 1-65535. If unset, server.js will default to 3000.
  if (process.env.PORT) {
    const portNum = parseInt(process.env.PORT, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      errors.push('PORT must be a valid integer between 1 and 65535 if set');
    }
  }

  // MAX_PAGE_SIZE: If set, must be a positive integer. There is no upper bound; values above
  // RECOMMENDED_MAX_PAGE_SIZE are allowed and warned about in validateAndExit. If unset, the
  // query service defaults to DEFAULT_MAX_PAGE_SIZE.
  if (process.env.MAX_PAGE_SIZE && parseMaxPageSize(process.env.MAX_PAGE_SIZE) === null) {
    errors.push('MAX_PAGE_SIZE must be a positive integer if set');
  }

  // DB_REQUEST_TIMEOUT: If set, must be a non-negative integer of milliseconds.
  // 0 disables the per-query timeout. If unset, DEFAULT_DB_REQUEST_TIMEOUT_MS applies.
  if (process.env.DB_REQUEST_TIMEOUT) {
    const requestTimeout = Number(process.env.DB_REQUEST_TIMEOUT.trim());
    if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 0) {
      errors.push('DB_REQUEST_TIMEOUT must be a non-negative integer of milliseconds if set');
    }
  }

  // LOG_LEVEL: If set, must be one of pino's recognized levels. If unset, the logger defaults to "info".
  if (process.env.LOG_LEVEL) {
    const level = process.env.LOG_LEVEL.trim().toLowerCase();
    if (!VALID_LOG_LEVELS.includes(level)) {
      errors.push(`LOG_LEVEL must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
    }
  }

  // ENABLE_SWAGGER_UI / ENABLE_OPEN_API_METADATA: If set, each must be "true" or "false",
  // matched case-insensitively. The document defaults to enabled and the UI follows it when
  // unset, so an unrecognized value must abort startup rather than be read as "not false",
  // which would leave the endpoint mounted.
  ['ENABLE_SWAGGER_UI', 'ENABLE_OPEN_API_METADATA'].forEach(name => {
    if (process.env[name]) {
      const value = process.env[name].trim().toLowerCase();
      if (value !== 'true' && value !== 'false') {
        errors.push(`${name} must be either "true" or "false" if set`);
      }
    }
  });

  // The Swagger UI derives its spec URL from its own path, so it has nothing to render when
  // the OpenAPI document is not served.
  if (isSwaggerUiEnabled() && !isOpenApiMetadataEnabled()) {
    errors.push('ENABLE_SWAGGER_UI cannot be enabled when ENABLE_OPEN_API_METADATA is false; unset ENABLE_SWAGGER_UI or set it to false');
  }

  // ASSESSMENT_ROSTERING_ENABLED: If set, must be "true" or "false", matched case-insensitively.
  // Defaults to disabled. A typo must abort startup rather than silently leave the service off.
  if (process.env.ASSESSMENT_ROSTERING_ENABLED) {
    const value = process.env.ASSESSMENT_ROSTERING_ENABLED.trim().toLowerCase();
    if (value !== 'true' && value !== 'false') {
      errors.push('ASSESSMENT_ROSTERING_ENABLED must be either "true" or "false" if set');
    }
  }

  // DB_TYPE must be either mssql or postgres
  if (!process.env.DB_TYPE) {
    errors.push('DB_TYPE must not be empty');
  } else if (process.env.DB_TYPE !== 'mssql' && process.env.DB_TYPE !== 'postgres') {
    errors.push('DB_TYPE must be either "mssql" or "postgres"');
  }


  const isMultiTenancyEnabled = process.env.MULTITENANCY_ENABLED === 'true';
  const tenantsConfigFromModule = isMultiTenancyEnabled && (process.env.TENANTS_CONFIG_MODULE || '').trim() !== '';

  // CONNECTION_CONFIG must be valid JSON with adminConnection if MULTITENANCY_ENABLED is false
  // (ODS/API only: it points at EdFi_Admin)
  if (isOdsPlatform && !isMultiTenancyEnabled) {
    if (!process.env.CONNECTION_CONFIG) {
      errors.push('CONNECTION_CONFIG must not be empty when MULTITENANCY_ENABLED is false');
    } else {
      try {
        const config = JSON.parse(process.env.CONNECTION_CONFIG);
        if (!config.adminConnection || typeof config.adminConnection !== 'string' || !config.adminConnection.trim()) {
          errors.push('CONNECTION_CONFIG must contain a non-empty adminConnection property');
        }
      } catch (e) {
        errors.push('CONNECTION_CONFIG must be valid JSON');
      }
    }
  }

  // PG_BOSS_CONNECTION_CONFIG must be valid JSON with adminConnection if DB_TYPE is postgres
  if (process.env.DB_TYPE === 'postgres') {
    if (!process.env.PG_BOSS_CONNECTION_CONFIG) {
      errors.push('PG_BOSS_CONNECTION_CONFIG must not be empty when DB_TYPE is postgres');
    } else {
      try {
        const config = JSON.parse(process.env.PG_BOSS_CONNECTION_CONFIG);
        if (!config.adminConnection || typeof config.adminConnection !== 'string' || !config.adminConnection.trim()) {
          errors.push('PG_BOSS_CONNECTION_CONFIG must contain a non-empty adminConnection property');
        }
      } catch (e) {
        errors.push('PG_BOSS_CONNECTION_CONFIG must be valid JSON');
      }
    }
  }

  // OAUTH2_ISSUERBASEURL must not be empty (ODS/API; DMS uses OAUTH2_ISSUER, checked below)
  if (isOdsPlatform && !process.env.OAUTH2_ISSUERBASEURL) {
    errors.push('OAUTH2_ISSUERBASEURL must not be empty');
  }

  // OAUTH2_AUDIENCE must not be empty
  if (!process.env.OAUTH2_AUDIENCE) {
    errors.push('OAUTH2_AUDIENCE must not be empty');
  }

  // OAUTH2_TOKENSIGNINGALG must be RS256 (ODS/API; DMS tokens name their algorithm in the JWKS)
  if (isOdsPlatform && !process.env.OAUTH2_TOKENSIGNINGALG) {
    errors.push('OAUTH2_TOKENSIGNINGALG must not be empty');
  } else if (process.env.OAUTH2_TOKENSIGNINGALG && process.env.OAUTH2_TOKENSIGNINGALG !== 'RS256') {
    errors.push('OAUTH2_TOKENSIGNINGALG must be "RS256"');
  }

  // OAUTH2_PUBLIC_KEY_PEM must not be empty (ODS/API only: tokens are verified with its PEM key)
  if (isOdsPlatform && !process.env.OAUTH2_PUBLIC_KEY_PEM) {
    errors.push('OAUTH2_PUBLIC_KEY_PEM must not be empty');
  }

  // TENANTS_CONNECTION_CONFIG must be valid JSON mapping tenant IDs to objects with adminConnection
  // when MULTITENANCY_ENABLED is true and TENANTS_CONFIG_MODULE is not set (plugin module skips this).
  // ODS/API only: it points at each tenant's EdFi_Admin.
  if (isOdsPlatform && isMultiTenancyEnabled && !tenantsConfigFromModule) {
    if (!process.env.TENANTS_CONNECTION_CONFIG) {
      errors.push('TENANTS_CONNECTION_CONFIG must not be empty when MULTITENANCY_ENABLED is true and TENANTS_CONFIG_MODULE is not set');
    } else {
      try {
        const tenants = JSON.parse(process.env.TENANTS_CONNECTION_CONFIG);
        if (typeof tenants !== 'object' || tenants === null || Array.isArray(tenants)) {
          errors.push('TENANTS_CONNECTION_CONFIG must be a JSON object mapping tenant IDs to config objects');
        } else {
          for (const [tenantId, config] of Object.entries(tenants)) {
            if (!config || typeof config !== 'object' || !config.adminConnection || typeof config.adminConnection !== 'string' || !config.adminConnection.trim()) {
              errors.push(`TENANTS_CONNECTION_CONFIG: tenant '${tenantId}' must have a non-empty adminConnection property`);
            }
            // OdsInstances is optional - if provided, must be valid JSON object with well-formed entries
            if (config.OdsInstances !== undefined) {
              if (typeof config.OdsInstances !== 'object' || config.OdsInstances === null || Array.isArray(config.OdsInstances)) {
                errors.push(`TENANTS_CONNECTION_CONFIG: tenant '${tenantId}' OdsInstances must be a JSON object if provided`);
              } else {
                for (const [instanceKey, instance] of Object.entries(config.OdsInstances)) {
                  if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
                    errors.push(`TENANTS_CONNECTION_CONFIG: tenant '${tenantId}', OdsInstances['${instanceKey}'] must be an object`);
                  } else {
                    if (!instance.ConnectionString || typeof instance.ConnectionString !== 'string' || !instance.ConnectionString.trim()) {
                      errors.push(`TENANTS_CONNECTION_CONFIG: tenant '${tenantId}', OdsInstances['${instanceKey}'] must have a non-empty ConnectionString`);
                    }
                    if (instance.ContextValueByKey !== undefined && (typeof instance.ContextValueByKey !== 'object' || instance.ContextValueByKey === null || Array.isArray(instance.ContextValueByKey))) {
                      errors.push(`TENANTS_CONNECTION_CONFIG: tenant '${tenantId}', OdsInstances['${instanceKey}'].ContextValueByKey must be an object if provided`);
                    }
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        errors.push('TENANTS_CONNECTION_CONFIG must be valid JSON');
      }
    }
  }

  // ODS_INSTANCES format validation (ODS/API single-tenant, if provided)
  if (isOdsPlatform && !isMultiTenancyEnabled && process.env.ODS_INSTANCES) {
    try {
      const odsInstances = JSON.parse(process.env.ODS_INSTANCES);
      if (typeof odsInstances !== 'object' || odsInstances === null || Array.isArray(odsInstances) || Object.keys(odsInstances).length === 0) {
        errors.push('ODS_INSTANCES must be a non-empty JSON object mapping instance IDs to instance configurations');
      } else {
        for (const [instanceKey, instance] of Object.entries(odsInstances)) {
          if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
            errors.push(`ODS_INSTANCES['${instanceKey}'] must be an object`);
          } else {
            if (!instance.ConnectionString || typeof instance.ConnectionString !== 'string' || !instance.ConnectionString.trim()) {
              errors.push(`ODS_INSTANCES['${instanceKey}'] must have a non-empty ConnectionString`);
            }
            if (instance.ContextValueByKey !== undefined && (typeof instance.ContextValueByKey !== 'object' || instance.ContextValueByKey === null || Array.isArray(instance.ContextValueByKey))) {
              errors.push(`ODS_INSTANCES['${instanceKey}'].ContextValueByKey must be an object if provided`);
            }
          }
        }
      }
    } catch (e) {
      errors.push('ODS_INSTANCES must be valid JSON');
    }
  }

  // Route context: ODS_CONTEXT_ROUTE_TEMPLATE belongs to the ODS/API and ROUTE_QUALIFIER_SEGMENTS
  // to DMS. Rejecting the other platform's variable avoids a setting that silently does nothing.
  if (isOdsPlatform) {
    if ((process.env.ROUTE_QUALIFIER_SEGMENTS || '').trim() !== '') {
      errors.push('ROUTE_QUALIFIER_SEGMENTS applies to PLATFORM=dms; use ODS_CONTEXT_ROUTE_TEMPLATE with PLATFORM=ods');
    }
  } else {
    if ((process.env.ODS_CONTEXT_ROUTE_TEMPLATE || '').trim() !== '') {
      errors.push('ODS_CONTEXT_ROUTE_TEMPLATE applies to PLATFORM=ods; use ROUTE_QUALIFIER_SEGMENTS with PLATFORM=dms');
    }
    errors.push(...parseRouteQualifierSegments(process.env.ROUTE_QUALIFIER_SEGMENTS).errors);
    errors.push(...validateDmsSettings(process.env, isMultiTenancyEnabled));
  }

  const isHttpsEnabled = process.env.ENABLE_HTTPS === 'true';

  // TLS_KEY_PATH must not be empty if ENABLE_HTTPS is true
  if (isHttpsEnabled && !process.env.TLS_KEY_PATH) {
    errors.push('TLS_KEY_PATH must not be empty when ENABLE_HTTPS is true');
  }

  // TLS_CERT_PATH must not be empty if ENABLE_HTTPS is true
  if (isHttpsEnabled && !process.env.TLS_CERT_PATH) {
    errors.push('TLS_CERT_PATH must not be empty when ENABLE_HTTPS is true');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validates environment variables and exits the process if validation fails
 * Logs all validation errors to the console
 */
export function validateAndExit() {
  const { isValid, errors } = validateEnvironmentVariables();

  if (!isValid) {
    logger.fatal({ errors }, 'Environment variable validation failed; application startup aborted');
    process.exit(1);
  }

  logger.info('Environment variable validation passed');

  if (parsePlatform(process.env.PLATFORM) === PLATFORMS.DMS) {
    for (const warning of dmsTransportWarnings(process.env)) logger.warn(warning);
    for (const warning of dmsScopeWarnings(process.env, process.env.MULTITENANCY_ENABLED === 'true')) logger.warn(warning);
  }

  if (process.env.MAX_PAGE_SIZE) {
    const maxPageSize = parseMaxPageSize(process.env.MAX_PAGE_SIZE);
    if (maxPageSize > RECOMMENDED_MAX_PAGE_SIZE) {
      logger.warn(
        `MAX_PAGE_SIZE is set to ${maxPageSize}, above the recommended ${RECOMMENDED_MAX_PAGE_SIZE}. ` +
        'Clients can request pages up to this size; large pages increase memory use and ' +
        'response size and may exceed DB_REQUEST_TIMEOUT.'
      );
    }
  }
}
