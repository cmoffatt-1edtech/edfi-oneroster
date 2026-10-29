// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Settings for PLATFORM=dms (Ed-Fi API v8). Each reader returns parsed settings; validateDmsSettings
 * returns the problems envValidator reports at startup.
 */

export const TOKEN_PROFILES = Object.freeze({
  CMS_SELF_CONTAINED: 'cms-self-contained',
  STANDARD: 'standard'
});

const SCOPE_PREFIX = 'https://purl.imsglobal.org/spec/or/v1p2/scope/';

// Outbound calls to the Configuration Service and the token issuer (DMS_HTTP_TIMEOUT_MS)
export const DEFAULT_DMS_HTTP_TIMEOUT_MS = 10_000;
const KNOWN_SCOPES = ['roster.readonly', 'roster-core.readonly', 'roster-demographics.readonly'].map(s => SCOPE_PREFIX + s);

function trimmed(name, env) {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function parseBoolean(value, fallback) {
  if (value === null) return fallback;
  return value.toLowerCase() === 'true';
}

/** Expand "roster.readonly" to the full OneRoster scope URI; full URIs pass through. */
export function expandScope(scope) {
  return scope.startsWith('https://') ? scope : SCOPE_PREFIX + scope;
}

/**
 * ONEROSTER_CLAIMSET_SCOPES: JSON object from DMS claim-set name to OneRoster scopes, e.g.
 *   {"OneRoster-ReadOnly":["roster.readonly","roster-demographics.readonly"],"OneRoster-Core":["roster-core.readonly"]}
 * Short names are expanded to https://purl.imsglobal.org/spec/or/v1p2/scope/<name>.
 * @returns {{ map: Map<string, Set<string>>, errors: string[] }}
 */
export function parseClaimSetScopes(value) {
  const errors = [];
  const map = new Map();
  if (!value || !value.trim()) {
    return { map, errors: ['ONEROSTER_CLAIMSET_SCOPES must not be empty when PLATFORM is dms'] };
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { map, errors: ['ONEROSTER_CLAIMSET_SCOPES must be valid JSON'] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { map, errors: ['ONEROSTER_CLAIMSET_SCOPES must be a JSON object mapping claim-set names to scope arrays'] };
  }

  for (const [claimSet, scopes] of Object.entries(parsed)) {
    if (!Array.isArray(scopes) || scopes.some(s => typeof s !== 'string')) {
      errors.push(`ONEROSTER_CLAIMSET_SCOPES: '${claimSet}' must map to an array of scope strings`);
      continue;
    }
    const expanded = scopes.map(s => expandScope(s.trim()));
    const unknown = expanded.filter(s => !KNOWN_SCOPES.includes(s));
    if (unknown.length > 0) {
      errors.push(`ONEROSTER_CLAIMSET_SCOPES: '${claimSet}' has unknown scopes: ${unknown.join(', ')}`);
      continue;
    }
    map.set(claimSet, new Set(expanded));
  }
  return { map, errors };
}

let claimSetScopesCache = null;

/** The parsed claim-set map, read once. */
export function getClaimSetScopes(env = process.env) {
  if (env !== process.env) return parseClaimSetScopes(env.ONEROSTER_CLAIMSET_SCOPES).map;
  if (!claimSetScopesCache || claimSetScopesCache.source !== env.ONEROSTER_CLAIMSET_SCOPES) {
    claimSetScopesCache = { source: env.ONEROSTER_CLAIMSET_SCOPES, map: parseClaimSetScopes(env.ONEROSTER_CLAIMSET_SCOPES).map };
  }
  return claimSetScopesCache.map;
}

/** Token verification settings for DMS-issued tokens. */
export function getDmsTokenSettings(env = process.env) {
  return {
    profile: trimmed('OAUTH2_TOKEN_PROFILE', env) || TOKEN_PROFILES.CMS_SELF_CONTAINED,
    issuer: trimmed('OAUTH2_ISSUER', env),
    audience: trimmed('OAUTH2_AUDIENCE', env),
    metadataUrl: trimmed('OAUTH2_METADATA_URL', env),
    jwksUrl: trimmed('OAUTH2_JWKS_URL', env),
    tokenUrl: trimmed('OAUTH2_TOKEN_URL', env),
    clockSkewSeconds: Number(trimmed('OAUTH2_CLOCK_SKEW_SECONDS', env) ?? 60),
    timeoutMs: Number(trimmed('DMS_HTTP_TIMEOUT_MS', env) ?? DEFAULT_DMS_HTTP_TIMEOUT_MS)
  };
}

/**
 * Where DMS clients get tokens: OAUTH2_TOKEN_URL (usually the DMS /oauth/token, which DMS serves
 * with or without a tenant and qualifier prefix), else the issuer's /connect/token.
 */
export function getDmsTokenUrl(env = process.env) {
  const { tokenUrl, issuer } = getDmsTokenSettings(env);
  if (tokenUrl) return tokenUrl;
  return issuer ? `${issuer.replace(/\/+$/, '')}/connect/token` : null;
}

/** Configuration Service (CMS) access and data-store settings. */
export function getDmsDataStoreSettings(env = process.env) {
  const dataStoresJson = trimmed('DATA_STORES', env);
  return {
    dataStores: dataStoresJson ? JSON.parse(dataStoresJson) : null,
    configServiceUrl: trimmed('CONFIG_SERVICE_URL', env),
    clientId: trimmed('CONFIG_SERVICE_CLIENT_ID', env),
    clientSecret: trimmed('CONFIG_SERVICE_CLIENT_SECRET', env),
    scope: trimmed('CONFIG_SERVICE_SCOPE', env) || undefined,
    encryptionKey: trimmed('CONFIG_SERVICE_ENCRYPTION_KEY', env),
    allowLegacy: parseBoolean(trimmed('CONFIG_SERVICE_ALLOW_LEGACY_CONNECTION_STRINGS', env), true),
    cacheSeconds: Number(trimmed('DATA_STORE_CACHE_SECONDS', env) ?? 600),
    useReadReplica: parseBoolean(trimmed('USE_READ_REPLICA', env), false),
    timeoutMs: Number(trimmed('DMS_HTTP_TIMEOUT_MS', env) ?? DEFAULT_DMS_HTTP_TIMEOUT_MS)
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isPlainHttpOffHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Startup warnings for PLATFORM=dms: secrets or signing keys that would cross the network
 * without TLS. Plain http is normal on a private Docker network (the local stack), so these are
 * warnings, not errors.
 * @returns {string[]}
 */
export function dmsTransportWarnings(env) {
  const warnings = [];
  const configServiceUrl = trimmed('CONFIG_SERVICE_URL', env);
  if (!trimmed('DATA_STORES', env) && configServiceUrl && isPlainHttpOffHost(configServiceUrl)) {
    warnings.push('CONFIG_SERVICE_URL uses http: the Configuration Service client secret and the data stores\' ' +
      'connection strings cross the network unencrypted. Use https outside a private network.');
  }
  for (const name of ['OAUTH2_JWKS_URL', 'OAUTH2_METADATA_URL']) {
    const value = trimmed(name, env);
    if (value && isPlainHttpOffHost(value)) {
      warnings.push(`${name} uses http: the token signing keys are fetched without TLS, so anyone on the path ` +
        'could substitute a key and forge tokens. Use https outside a private network.');
    }
  }
  return warnings;
}

/**
 * Startup checks for PLATFORM=dms.
 * @param {Object} env
 * @param {boolean} multiTenancyEnabled
 * @returns {string[]} errors
 */
export function validateDmsSettings(env, multiTenancyEnabled) {
  const errors = [];

  // Tokens
  const profile = trimmed('OAUTH2_TOKEN_PROFILE', env);
  if (profile && !Object.values(TOKEN_PROFILES).includes(profile)) {
    errors.push(`OAUTH2_TOKEN_PROFILE must be one of: ${Object.values(TOKEN_PROFILES).join(', ')} if set`);
  }
  if (!trimmed('OAUTH2_ISSUER', env)) {
    errors.push('OAUTH2_ISSUER must not be empty when PLATFORM is dms (the exact iss of DMS tokens)');
  }
  const metadataUrl = trimmed('OAUTH2_METADATA_URL', env);
  const jwksUrl = trimmed('OAUTH2_JWKS_URL', env);
  if (!metadataUrl && !jwksUrl) {
    errors.push('OAUTH2_JWKS_URL or OAUTH2_METADATA_URL must be set when PLATFORM is dms');
  }
  for (const [name, value] of [['OAUTH2_METADATA_URL', metadataUrl], ['OAUTH2_JWKS_URL', jwksUrl], ['OAUTH2_TOKEN_URL', trimmed('OAUTH2_TOKEN_URL', env)]]) {
    if (value && !isHttpUrl(value)) errors.push(`${name} must be an http(s) URL if set`);
  }
  const skew = trimmed('OAUTH2_CLOCK_SKEW_SECONDS', env);
  if (skew !== null && !(Number.isInteger(Number(skew)) && Number(skew) >= 0)) {
    errors.push('OAUTH2_CLOCK_SKEW_SECONDS must be a non-negative integer if set');
  }

  // Scopes
  errors.push(...parseClaimSetScopes(env.ONEROSTER_CLAIMSET_SCOPES).errors);

  // Data stores
  const dataStoresJson = trimmed('DATA_STORES', env);
  let staticDataStores = null;
  if (dataStoresJson) {
    try {
      staticDataStores = JSON.parse(dataStoresJson);
      if (typeof staticDataStores !== 'object' || staticDataStores === null || Array.isArray(staticDataStores) || Object.keys(staticDataStores).length === 0) {
        errors.push('DATA_STORES must be a non-empty JSON object mapping data-store ids to configurations');
        staticDataStores = null;
      } else {
        for (const [id, config] of Object.entries(staticDataStores)) {
          if (!config || typeof config !== 'object' || typeof config.ConnectionString !== 'string' || !config.ConnectionString.trim()) {
            errors.push(`DATA_STORES['${id}'] must have a non-empty ConnectionString`);
          } else if (!config.ConnectionString.includes(';') && !trimmed('CONFIG_SERVICE_ENCRYPTION_KEY', env)) {
            errors.push(`DATA_STORES['${id}'] holds an encrypted connection string, so CONFIG_SERVICE_ENCRYPTION_KEY must be set`);
          }
          if (config?.ContextValueByKey !== undefined && (typeof config.ContextValueByKey !== 'object' || config.ContextValueByKey === null || Array.isArray(config.ContextValueByKey))) {
            errors.push(`DATA_STORES['${id}'].ContextValueByKey must be an object if provided`);
          }
        }
      }
    } catch {
      errors.push('DATA_STORES must be valid JSON');
    }
    if (multiTenancyEnabled) {
      errors.push('DATA_STORES is single-tenant only; with MULTITENANCY_ENABLED=true data stores come from the Configuration Service');
    }
  } else {
    for (const name of ['CONFIG_SERVICE_URL', 'CONFIG_SERVICE_CLIENT_ID', 'CONFIG_SERVICE_CLIENT_SECRET', 'CONFIG_SERVICE_ENCRYPTION_KEY']) {
      if (!trimmed(name, env)) {
        errors.push(`${name} must not be empty when PLATFORM is dms and DATA_STORES is not set`);
      }
    }
    const url = trimmed('CONFIG_SERVICE_URL', env);
    if (url && !isHttpUrl(url)) errors.push('CONFIG_SERVICE_URL must be an http(s) URL');
  }

  const timeout = trimmed('DMS_HTTP_TIMEOUT_MS', env);
  if (timeout !== null && !(Number.isInteger(Number(timeout)) && Number(timeout) > 0)) {
    errors.push('DMS_HTTP_TIMEOUT_MS must be a positive integer (milliseconds) if set');
  }

  const cacheSeconds = trimmed('DATA_STORE_CACHE_SECONDS', env);
  if (cacheSeconds !== null && !(Number.isInteger(Number(cacheSeconds)) && Number(cacheSeconds) >= 0)) {
    errors.push('DATA_STORE_CACHE_SECONDS must be a non-negative integer if set');
  }
  for (const name of ['USE_READ_REPLICA', 'CONFIG_SERVICE_ALLOW_LEGACY_CONNECTION_STRINGS']) {
    const value = trimmed(name, env);
    if (value !== null && !['true', 'false'].includes(value.toLowerCase())) {
      errors.push(`${name} must be either "true" or "false" if set`);
    }
  }

  return errors;
}
