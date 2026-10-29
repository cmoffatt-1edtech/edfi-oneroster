// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { getLogger } from '../../utils/logger.js';
import { DEFAULT_CONFIG_SERVICE_SCOPE, DEFAULT_DMS_HTTP_TIMEOUT_MS } from '../../config/dms-config.js';

const logger = getLogger('ConfigurationServiceClient');

export { DEFAULT_CONFIG_SERVICE_SCOPE };

// Refresh the token this long before it expires
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class ConfigurationServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ConfigurationServiceError';
    this.status = status;
  }
}

function joinUrl(base, suffix) {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`;
}

/**
 * Read-only client for the DMS Configuration Service Management API (/v3).
 *
 * Holds one client-credentials token and reuses it until shortly before it expires: the
 * self-contained identity provider allows only 15 active tokens per client, so a token per
 * request would soon be refused. Concurrent callers share one token request.
 */
export class ConfigurationServiceClient {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl - e.g. http://ed-fi-api-config:8081
   * @param {string} options.clientId
   * @param {string} options.clientSecret
   * @param {string} [options.scope] - Defaults to the auth-metadata read-only scope
   * @param {number} [options.timeoutMs] - Per request; a request that takes longer fails with a
   *   ConfigurationServiceError (status 504) instead of holding the caller
   * @param {Function} [options.fetchImpl] - Injectable for tests
   * @param {Function} [options.now] - Injectable clock (ms)
   */
  constructor({
    baseUrl, clientId, clientSecret, scope = DEFAULT_CONFIG_SERVICE_SCOPE, timeoutMs = DEFAULT_DMS_HTTP_TIMEOUT_MS, fetchImpl = fetch, now = Date.now
  }) {
    if (!baseUrl || !clientId || !clientSecret) {
      throw new Error('ConfigurationServiceClient needs baseUrl, clientId and clientSecret');
    }
    this.baseUrl = baseUrl;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.scope = scope;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenRequest = null;
  }

  /** fetch with the request timeout; a timeout becomes a ConfigurationServiceError (504). */
  async fetch(url, options, what) {
    try {
      return await this.fetchImpl(url, { ...options, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw new ConfigurationServiceError(`Configuration Service ${what} timed out after ${this.timeoutMs} ms`, 504);
      }
      throw error;
    }
  }

  async getToken() {
    if (this.token && this.now() < this.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this.token;
    }
    if (!this.tokenRequest) {
      this.tokenRequest = this.requestToken().finally(() => { this.tokenRequest = null; });
    }
    return this.tokenRequest;
  }

  async requestToken() {
    const res = await this.fetch(joinUrl(this.baseUrl, 'connect/token'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: this.scope
      })
    }, 'token request');
    if (!res.ok) {
      throw new ConfigurationServiceError(`Configuration Service token request failed with ${res.status}`, res.status);
    }
    const body = await res.json();
    this.token = body.access_token;
    this.tokenExpiresAt = this.now() + Number(body.expires_in || 0) * 1000;
    logger.debug('Obtained a Configuration Service token');
    return this.token;
  }

  /**
   * Drop a token the Configuration Service refused, but only while it is still the cached one: a
   * late 401 for an old token must not discard the replacement another request already obtained,
   * or every such response would cost a token (the identity provider allows 15 active tokens).
   */
  invalidateToken(token) {
    if (this.token === token) {
      this.token = null;
      this.tokenExpiresAt = 0;
    }
  }

  /**
   * GET a Management API path. Retries once with a new token on 401 (revoked or expired early).
   * @returns {Promise<*>} The parsed body, or null on 404
   */
  async get(path, { tenant = null } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      const headers = { Authorization: `Bearer ${token}` };
      if (tenant) headers.Tenant = tenant;

      const res = await this.fetch(joinUrl(this.baseUrl, path), { headers }, `GET ${path}`);
      if (res.status === 401 && attempt === 0) {
        this.invalidateToken(token);
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new ConfigurationServiceError(`Configuration Service GET ${path} failed with ${res.status}`, res.status);
      }
      return res.json();
    }
    throw new ConfigurationServiceError(`Configuration Service GET ${path} was not authorized`, 401);
  }

  getDataStores(tenant = null) {
    return this.get('v3/dataStores', { tenant });
  }

  getTenants() {
    return this.get('v3/tenants');
  }

  /** The API client record for a client_id within a tenant, or null when it is not there. */
  getApiClient(clientId, tenant = null) {
    return this.get(`v3/apiClients/${encodeURIComponent(clientId)}`, { tenant });
  }
}
