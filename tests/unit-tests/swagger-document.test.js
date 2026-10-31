// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect, afterEach } from '@jest/globals';
import { readFileSync } from 'fs';
import YAML from 'yaml';
import { loadSwaggerDocument, mergeSwaggerFragment } from '../../src/config/swagger-document.js';

const TOKEN_URL = 'https://api.example.org/oauth/token';
const ASSESSMENT_PATH = '/ims/oneroster/assessmentRostering/v1p0/assessments';

describe('loadSwaggerDocument', () => {
  const original = process.env.ASSESSMENT_ROSTERING_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.ASSESSMENT_ROSTERING_ENABLED;
    else process.env.ASSESSMENT_ROSTERING_ENABLED = original;
  });

  test('with assessment rostering off, is exactly config/swagger.yml with the token URL, as before', () => {
    const file = readFileSync(new URL('../../config/swagger.yml', import.meta.url), 'utf8');
    const before = YAML.parse(file.replace('{OAUTH_TOKEN_URL}', TOKEN_URL));

    expect(JSON.stringify(loadSwaggerDocument(TOKEN_URL, { assessmentRostering: false }))).toBe(JSON.stringify(before));
  });

  test('follows ASSESSMENT_ROSTERING_ENABLED by default', () => {
    delete process.env.ASSESSMENT_ROSTERING_ENABLED;
    expect(loadSwaggerDocument(TOKEN_URL).paths[ASSESSMENT_PATH]).toBeUndefined();

    process.env.ASSESSMENT_ROSTERING_ENABLED = 'true';
    expect(loadSwaggerDocument(TOKEN_URL).paths[ASSESSMENT_PATH]).toBeDefined();
  });

  test('with assessment rostering on, adds its tag, paths and schemas after the existing ones', () => {
    const off = loadSwaggerDocument(TOKEN_URL, { assessmentRostering: false });
    const on = loadSwaggerDocument(TOKEN_URL, { assessmentRostering: true });

    expect(Object.keys(on.paths).slice(0, Object.keys(off.paths).length)).toEqual(Object.keys(off.paths));
    expect(Object.keys(on.paths).filter(path => !(path in off.paths))).toEqual([
      ASSESSMENT_PATH,
      `${ASSESSMENT_PATH}/{id}`,
      `${ASSESSMENT_PATH}/{id}/assessmentOfferings`,
      '/ims/oneroster/assessmentRostering/v1p0/assessmentOfferings',
      '/ims/oneroster/assessmentRostering/v1p0/assessmentOfferings/{id}',
      '/ims/oneroster/assessmentRostering/v1p0/assessmentOfferings/{id}/assessmentEnrollments',
      '/ims/oneroster/assessmentRostering/v1p0/assessmentEnrollments',
      '/ims/oneroster/assessmentRostering/v1p0/assessmentEnrollments/{id}'
    ]);
    expect(on.tags.map(tag => tag.name)).toEqual([...off.tags.map(tag => tag.name), 'Assessment Rostering']);
    expect(Object.keys(on.components.schemas)).toEqual(
      [...Object.keys(off.components.schemas), 'assessment', 'assessmentOffering', 'assessmentEnrollment']);
    expect(on.components.securitySchemes).toEqual(off.components.securitySchemes);
  });

  test('testingWindows, subjects and grades are arrays', () => {
    const { schemas } = loadSwaggerDocument(TOKEN_URL, { assessmentRostering: true }).components;

    expect(schemas.assessmentOffering.properties.testingWindows.type).toBe('array');
    expect(schemas.assessment.properties.subjects.type).toBe('array');
    expect(schemas.assessment.properties.grades.type).toBe('array');
  });
});

describe('mergeSwaggerFragment', () => {
  test('refuses a fragment that redefines a path or schema', () => {
    const document = { paths: { '/a': {} }, components: { schemas: { user: {} } } };

    expect(() => mergeSwaggerFragment(document, { paths: { '/a': {} } })).toThrow('OpenAPI fragment redefines: /a');
    expect(() => mergeSwaggerFragment(document, { components: { schemas: { user: {} } } })).toThrow('redefines: user');
  });
});
