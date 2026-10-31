// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * OneRoster assessment rostering (first draft)
 *
 * Three read-only resources over Ed-Fi assessment registration data (Data Standard 5.2 and
 * later): assessments, assessmentOfferings and assessmentEnrollments. The 1EdTech service has no
 * published name or version yet, so the base path is provisional and lives here only.
 *
 * Off by default. ASSESSMENT_ROSTERING_ENABLED=true mounts the routes and adds the service to the
 * OpenAPI document, the discovery document and the view refresh jobs. envValidator rejects any
 * value other than "true" or "false", case-insensitively.
 */

// Under /ims/oneroster, beside /rostering/v1p2
export const ASSESSMENT_ROSTERING_BASE_PATH = '/assessmentRostering/v1p0';

// Endpoint names, which are also the oneroster12 view names
export const ASSESSMENT_ENDPOINTS = Object.freeze({
  assessments: 'assessments',
  assessmentOfferings: 'assessmentofferings',
  assessmentEnrollments: 'assessmentenrollments'
});

// One row per (assessment, offering, organization, role); read by the authorization filters
export const ASSESSMENT_AUTH_ORGS_VIEW = 'assessmentauthorgs';

// Every oneroster12 view the service adds, in refresh order (they don't depend on each other)
export const ASSESSMENT_VIEWS = Object.freeze([
  ...Object.values(ASSESSMENT_ENDPOINTS),
  ASSESSMENT_AUTH_ORGS_VIEW
]);

export const ASSESSMENT_ENDPOINT_NAMES = new Set(Object.values(ASSESSMENT_ENDPOINTS));

/**
 * @returns {boolean} Whether the assessment rostering service is switched on
 */
export function isAssessmentRosteringEnabled() {
  return (process.env.ASSESSMENT_ROSTERING_ENABLED || '').trim().toLowerCase() === 'true';
}
