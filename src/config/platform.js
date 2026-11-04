// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Target platform selection.
 *
 * PLATFORM=ods (the default) serves OneRoster from an Ed-Fi ODS/API 7.x deployment: tokens minted by
 * the ODS/API, connection strings in EdFi_Admin, USI-keyed auth views.
 * PLATFORM=dms serves it from Ed-Fi API v8, the Data Management Service: tokens from the
 * Configuration Service, data stores from its Management API, DocumentId-keyed auth views.
 */

export const PLATFORMS = Object.freeze({
  ODS: 'ods',
  DMS: 'dms'
});

export const DEFAULT_PLATFORM = PLATFORMS.ODS;

const VALID_PLATFORMS = Object.values(PLATFORMS);

/**
 * Parse a PLATFORM value. Unset or blank means the default; matching is case-insensitive.
 * @param {string|undefined} value
 * @returns {string|null} A PLATFORMS value, or null if the value is not recognised
 */
export function parsePlatform(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_PLATFORM;
  }

  const normalized = String(value).trim().toLowerCase();
  return VALID_PLATFORMS.includes(normalized) ? normalized : null;
}

/**
 * The configured platform. Throws on an unrecognised value; envValidator reports it at startup.
 * @returns {string} A PLATFORMS value
 */
export function getPlatform() {
  const platform = parsePlatform(process.env.PLATFORM);
  if (!platform) {
    throw new Error(`PLATFORM must be one of: ${VALID_PLATFORMS.join(', ')}`);
  }
  return platform;
}

export function isDmsPlatform() {
  return getPlatform() === PLATFORMS.DMS;
}
