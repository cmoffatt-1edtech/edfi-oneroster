// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { resolveEsmModuleSpecifier } from './resolve-esm-module-specifier.js';
import { isDmsPlatform } from './platform.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('AppSecrets');

// PLATFORM=dms: what loadAppSecrets() may return, and the variable each one sets
const DMS_SECRETS = Object.freeze({
  configServiceClientSecret: 'CONFIG_SERVICE_CLIENT_SECRET',
  configServiceEncryptionKey: 'CONFIG_SERVICE_ENCRYPTION_KEY'
});

/**
 * When APP_SECRETS_MODULE is set (non-empty), load secrets via loadAppSecrets() and set process.env.
 * Must run before env validation and before importing app.js. See docs/app-secrets-plugin.md.
 *
 * PLATFORM=ods (default): the ODS encryption key and OAuth2 public key (both required), and
 * optionally the pg-boss config.
 * PLATFORM=dms: any of the Configuration Service client secret, the connection-string encryption
 * key, static data stores (DATA_STORES) and the pg-boss config; at least one. Startup validation
 * then checks that the combination is complete, as it does for the environment.
 */
export async function bootstrapAppSecretsIfNeeded() {
  const modulePath = (process.env.APP_SECRETS_MODULE || '').trim();
  if (!modulePath) {
    return;
  }

  const moduleHref = resolveEsmModuleSpecifier(modulePath);
  const mod = await import(moduleHref);
  if (typeof mod.loadAppSecrets !== 'function') {
    throw new Error('App secrets plugin must export async function loadAppSecrets');
  }

  const secrets = await mod.loadAppSecrets();
  const assigned = isDmsPlatform() ? assignDmsSecrets(secrets) : assignOdsSecrets(secrets);
  assignPgBoss(secrets);

  logger.info(`Loaded via plugin${assigned.length ? `: ${assigned.join(', ')}` : ''}`);
}

function assignOdsSecrets(secrets) {
  const odsKey = secrets?.odsConnectionStringEncryptionKey;
  const pem = secrets?.oauth2PublicKeyPem;

  if (typeof odsKey !== 'string' || !odsKey.trim()) {
    throw new Error('loadAppSecrets must return a non-empty string odsConnectionStringEncryptionKey');
  }
  if (typeof pem !== 'string' || !pem.trim()) {
    throw new Error('loadAppSecrets must return a non-empty string oauth2PublicKeyPem');
  }

  process.env.ODS_CONNECTION_STRING_ENCRYPTION_KEY = odsKey.trim();
  process.env.OAUTH2_PUBLIC_KEY_PEM = pem.trim();
  return [];
}

/** @returns {string[]} the names of the variables set (never their values) */
function assignDmsSecrets(secrets) {
  const assigned = [];
  for (const [field, variable] of Object.entries(DMS_SECRETS)) {
    const value = secrets?.[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`loadAppSecrets ${field} must be a non-empty string when returned`);
    }
    process.env[variable] = value.trim();
    assigned.push(variable);
  }

  const dataStores = secrets?.dataStores;
  if (dataStores !== undefined && dataStores !== null) {
    if (typeof dataStores !== 'object' || Array.isArray(dataStores) || Object.keys(dataStores).length === 0) {
      throw new Error('loadAppSecrets dataStores must be a non-empty object mapping data-store ids to configurations when returned');
    }
    process.env.DATA_STORES = JSON.stringify(dataStores);
    assigned.push('DATA_STORES');
  }

  if (assigned.length === 0 && (secrets?.pgBossConnectionConfig === undefined || secrets?.pgBossConnectionConfig === null)) {
    throw new Error(
      'With PLATFORM=dms, loadAppSecrets must return at least one of configServiceClientSecret, ' +
      'configServiceEncryptionKey, dataStores or pgBossConnectionConfig'
    );
  }
  return assigned;
}

function assignPgBoss(secrets) {
  const pgBoss = secrets?.pgBossConnectionConfig;
  if (pgBoss !== undefined && pgBoss !== null) {
    const ac = pgBoss?.adminConnection;
    if (typeof ac !== 'string' || !ac.trim()) {
      throw new Error('loadAppSecrets pgBossConnectionConfig.adminConnection must be a non-empty string when pgBossConnectionConfig is returned');
    }
    process.env.PG_BOSS_CONNECTION_CONFIG = JSON.stringify({ adminConnection: ac.trim() });
  }
}
