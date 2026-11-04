// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { getOdsContextConfig } from './ods-context-config.js';
import { isDmsPlatform } from './platform.js';

/**
 * Route context: the path segments between the (optional) tenant and /ims/oneroster that select
 * a database.
 *
 * - ODS: one segment from ODS_CONTEXT_ROUTE_TEMPLATE, e.g. {schoolYearFromRoute:range(2026,2027)}.
 * - DMS: the ordered names in ROUTE_QUALIFIER_SEGMENTS, e.g. districtId,schoolYear, matching the
 *   DMS AppSettings__RouteQualifierSegments setting so both APIs share one URL shape.
 */

// Express 5 route parameter names must be identifier-like. tenantId and id are already route
// parameters of this API, so a qualifier with either name would collide with them.
const PARAMETER_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_PARAMETER_NAMES = ['tenantid', 'id'];

/**
 * Parse ROUTE_QUALIFIER_SEGMENTS the way DMS does: split on commas, trim, drop empty entries.
 * @param {string|undefined} value
 * @returns {{ names: string[], errors: string[] }} names is empty when the value is unset or blank
 */
export function parseRouteQualifierSegments(value) {
  const names = (value || '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);

  const errors = [];

  const invalid = names.filter(name => !PARAMETER_NAME_PATTERN.test(name));
  if (invalid.length > 0) {
    errors.push(`ROUTE_QUALIFIER_SEGMENTS contains names that are not valid route parameter names: ${invalid.join(', ')}`);
  }

  const reserved = names.filter(name => RESERVED_PARAMETER_NAMES.includes(name.toLowerCase()));
  if (reserved.length > 0) {
    errors.push(`ROUTE_QUALIFIER_SEGMENTS uses names reserved by this API's routes: ${reserved.join(', ')}`);
  }

  // DMS compares qualifier names case-insensitively and rejects names that collide that way
  const seen = new Map();
  for (const name of names) {
    const key = name.toLowerCase();
    seen.set(key, [...(seen.get(key) || []), name]);
  }
  const colliding = [...seen.values()].filter(group => group.length > 1).flat();
  if (colliding.length > 0) {
    errors.push(`ROUTE_QUALIFIER_SEGMENTS contains names that are equal under case-insensitive comparison: ${colliding.join(', ')}`);
  }

  return { names, errors };
}

/**
 * The route context for the configured platform.
 * @returns {Object|null} { source, parameterNames, ...odsTemplateFields } or null when the route
 *   carries no context segments. For ODS the parsed template fields (parameterName,
 *   constraintType, constraintArgs, fullConstraint) are kept so existing callers keep working.
 */
export function getRouteContextConfig() {
  if (isDmsPlatform()) {
    const { names, errors } = parseRouteQualifierSegments(process.env.ROUTE_QUALIFIER_SEGMENTS);
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
    return names.length > 0 ? { source: 'qualifierSegments', parameterNames: names } : null;
  }

  const odsContextConfig = getOdsContextConfig();
  if (!odsContextConfig) {
    return null;
  }
  return { ...odsContextConfig, source: 'odsTemplate', parameterNames: [odsContextConfig.parameterName] };
}
