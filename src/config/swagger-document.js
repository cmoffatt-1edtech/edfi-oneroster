// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import fs from 'fs';
import YAML from 'yaml';
import { isAssessmentRosteringEnabled } from './assessment-rostering.js';

const SWAGGER_FILE = new URL('../../config/swagger.yml', import.meta.url);
const ASSESSMENT_ROSTERING_FILE = new URL('../../config/swagger-assessment-rostering.yml', import.meta.url);

/**
 * Add a partial document's tags, paths and component schemas to an OpenAPI document. A path or
 * schema defined in both is an authoring mistake, so it throws rather than silently replacing one.
 * @param {Object} document - the document to extend (modified in place)
 * @param {Object} fragment - { tags, paths, components: { schemas } }
 * @returns {Object} the document
 */
export function mergeSwaggerFragment(document, fragment) {
  const clashes = [
    ...Object.keys(fragment.paths || {}).filter(path => path in (document.paths || {})),
    ...Object.keys(fragment.components?.schemas || {}).filter(name => name in (document.components?.schemas || {}))
  ];
  if (clashes.length > 0) {
    throw new Error(`OpenAPI fragment redefines: ${clashes.join(', ')}`);
  }

  document.tags = [...(document.tags || []), ...(fragment.tags || [])];
  document.paths = { ...document.paths, ...fragment.paths };
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...fragment.components?.schemas }
  };
  return document;
}

/**
 * The OpenAPI document the service serves: config/swagger.yml with the token URL filled in, plus
 * config/swagger-assessment-rostering.yml when assessment rostering is switched on.
 * @param {string} tokenUrl - replaces {OAUTH_TOKEN_URL}
 * @param {Object} [options]
 * @param {boolean} [options.assessmentRostering] - defaults to ASSESSMENT_ROSTERING_ENABLED
 * @returns {Object}
 */
export function loadSwaggerDocument(tokenUrl, { assessmentRostering = isAssessmentRosteringEnabled() } = {}) {
  const file = fs.readFileSync(SWAGGER_FILE, 'utf8');
  const document = YAML.parse(file.replace('{OAUTH_TOKEN_URL}', tokenUrl));

  if (assessmentRostering) {
    mergeSwaggerFragment(document, YAML.parse(fs.readFileSync(ASSESSMENT_ROSTERING_FILE, 'utf8')));
  }

  return document;
}
