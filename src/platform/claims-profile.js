// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { getPlatform, PLATFORMS } from '../config/platform.js';
import { getClaimSetScopes } from '../config/dms-config.js';
import { getLogger } from '../utils/logger.js';

/**
 * Claims profiles: how each platform's access tokens carry the facts this service needs.
 *
 * Every profile implements:
 *   getScopes(payload)                   -> Set<string> of OneRoster scope URIs
 *   getEducationOrganizationIds(payload) -> Array of education organization IDs
 *   getTenantId(payload)                 -> tenant claim, or null when the token carries none
 * plus platform-specific readers for selecting the database (ODS instance or DMS data store).
 * payload is the verified JWT payload (req.auth.payload); it may be undefined.
 */

const logger = getLogger('ClaimsProfile');

/**
 * Ed-Fi ODS/API 7.x tokens: OneRoster scopes in `scope`, `educationOrganizationId` as a string or
 * array, `tenantId`, and the ODS instance as `odsInstanceId` or the JSON `odsInstances` claim.
 */
export const odsClaimsProfile = Object.freeze({
  platform: PLATFORMS.ODS,

  /** OAuth2 "scope" as a space-delimited string or an array of strings. */
  getScopes(payload) {
    const rawScope = payload?.scope;

    if (typeof rawScope === 'string') {
      return new Set(rawScope.split(/\s+/).filter(Boolean));
    }

    if (Array.isArray(rawScope)) {
      const normalizedScopes = rawScope
        .filter((value) => typeof value === 'string')
        .flatMap((value) => value.split(/\s+/))
        .filter(Boolean);

      return new Set(normalizedScopes);
    }

    return new Set();
  },

  getEducationOrganizationIds(payload) {
    if (!payload) {
      return [];
    }

    const orgIds = payload.educationOrganizationId || [];

    return Array.isArray(orgIds) ? orgIds : [orgIds];
  },

  getTenantId(payload) {
    if (!payload) {
      return null;
    }
    return payload.tenantId;
  },

  /** The singular ODS instance claim, under any of the spellings the ODS/API has used. */
  getOdsInstanceId(payload) {
    if (!payload) {
      return null;
    }

    const odsInstanceId = payload.odsInstanceId || payload.ods_instance_id || payload.OdsInstanceId;

    return odsInstanceId ? parseInt(odsInstanceId, 10) : null;
  },

  /** The plural `odsInstances` claim: a JSON string of { OdsInstances: [...] }. */
  getOdsInstances(payload) {
    if (!payload?.odsInstances) return [];

    try {
      const parsed = JSON.parse(payload.odsInstances);
      return parsed.OdsInstances || [];
    } catch (error) {
      logger.warn(`Failed to parse odsInstances JSON: ${error.message}`);
      return [];
    }
  }
});

/**
 * Parse a comma-separated claim. DMS issues `educationOrganizationIds` and `dataStoreIds` as one
 * CSV string ("255901,255902"); an array of such strings is accepted too.
 */
function parseCsvClaim(value) {
  const parts = Array.isArray(value) ? value : [value];

  return parts
    .filter(part => typeof part === 'string' || typeof part === 'number')
    .flatMap(part => String(part).split(','))
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * Ed-Fi API v8 (DMS) tokens, issued by the Configuration Service or Keycloak: `scope` is the
 * application's claim-set name, `educationOrganizationIds` and `dataStoreIds` are CSV strings,
 * and there is no tenant claim.
 */
export const dmsClaimsProfile = Object.freeze({
  platform: PLATFORMS.DMS,

  /**
   * DMS reads the whole `scope` claim as the claim-set name, so the OneRoster scopes come from
   * ONEROSTER_CLAIMSET_SCOPES. An unmapped claim set has no scopes, which the scope check turns
   * into 403 "Insufficient scope".
   */
  getScopes(payload) {
    const claimSet = this.getClaimSetName(payload);
    const scopes = claimSet ? getClaimSetScopes().get(claimSet) : null;
    if (claimSet && !scopes) {
      logger.warn(`Claim set '${claimSet}' is not mapped to OneRoster scopes (ONEROSTER_CLAIMSET_SCOPES)`);
    }
    return new Set(scopes || []);
  },

  getEducationOrganizationIds(payload) {
    return parseCsvClaim(payload?.educationOrganizationIds);
  },

  /** DMS tokens carry no tenant claim; the tenant comes from the route and is checked with CMS. */
  getTenantId() {
    return null;
  },

  getClaimSetName(payload) {
    const scope = payload?.scope;
    return typeof scope === 'string' && scope.trim() ? scope.trim() : null;
  },

  /** Empty (self-contained provider) or absent (Keycloak) means no data store is authorized. */
  getDataStoreIds(payload) {
    return parseCsvClaim(payload?.dataStoreIds);
  }
});

const PROFILES = {
  [PLATFORMS.ODS]: odsClaimsProfile,
  [PLATFORMS.DMS]: dmsClaimsProfile
};

/**
 * @param {string} [platform] - Defaults to the configured PLATFORM
 */
export function getClaimsProfile(platform = getPlatform()) {
  return PROFILES[platform];
}
