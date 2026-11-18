// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect, afterEach } from '@jest/globals';
import { readFileSync } from 'fs';
import YAML from 'yaml';
import { loadSwaggerDocument, mergeSwaggerFragment } from '../../src/config/swagger-document.js';

const TOKEN_URL = 'https://api.example.org/oauth/token';
const ASSESSMENT_PATH = '/ims/oneroster/assessment-registration/v1p0/assessments';

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
      '/ims/oneroster/assessment-registration/v1p0/assessmentOfferings',
      '/ims/oneroster/assessment-registration/v1p0/assessmentOfferings/{id}',
      '/ims/oneroster/assessment-registration/v1p0/assessmentOfferings/{id}/assessmentEnrollments',
      '/ims/oneroster/assessment-registration/v1p0/assessmentEnrollments',
      '/ims/oneroster/assessment-registration/v1p0/assessmentEnrollments/{id}'
    ]);
    expect(on.tags.map(tag => tag.name)).toEqual([...off.tags.map(tag => tag.name), 'Assessment Registration']);
    expect(Object.keys(on.components.schemas)).toEqual(
      [...Object.keys(off.components.schemas), 'assessment', 'assessmentOffering', 'assessmentEnrollment']);
    expect(on.components.securitySchemes).toEqual(off.components.securitySchemes);
  });

  test('terms, subjects and grades are arrays', () => {
    const { schemas } = loadSwaggerDocument(TOKEN_URL, { assessmentRostering: true }).components;

    expect(schemas.assessmentOffering.properties.terms.type).toBe('array');
    expect(schemas.assessment.properties.subjects.type).toBe('array');
    expect(schemas.assessment.properties.grades.type).toBe('array');
  });

  test('the schemas list the fields the controller can select, and no others', async () => {
    const { schemas } = loadSwaggerDocument(TOKEN_URL, { assessmentRostering: true }).components;
    const { assessmentSelectableFields } = await import('../../src/controllers/unified/oneRosterController.js');

    for (const [schema, view] of [['assessment', 'assessments'], ['assessmentOffering', 'assessmentofferings'], ['assessmentEnrollment', 'assessmentenrollments']]) {
      expect([schema, Object.keys(schemas[schema].properties).sort()]).toEqual([schema, [...assessmentSelectableFields[view]].sort()]);
    }
  });

  test('an offering has one start date and one end date, and no list of windows', () => {
    const { properties } = loadSwaggerDocument(TOKEN_URL, { assessmentRostering: true }).components.schemas.assessmentOffering;

    expect(properties.startDate).toEqual(expect.objectContaining({ type: 'string', format: 'date' }));
    expect(properties.endDate).toEqual(expect.objectContaining({ type: 'string', format: 'date' }));
    expect(properties).not.toHaveProperty('testingWindows');
    expect(properties).not.toHaveProperty('academicSession');
  });

  test('links to rostering records are written from the rostering base path', () => {
    const { schemas } = loadSwaggerDocument(TOKEN_URL, { assessmentRostering: true }).components;
    const hrefs = Object.values(schemas).filter((schema, index) => index >= Object.keys(schemas).indexOf('assessment'))
      .flatMap(schema => Object.values(schema.properties))
      .map(property => (property.items ?? property).properties?.href?.description)
      .filter(Boolean);

    expect(hrefs.length).toBeGreaterThan(8);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/(assessments|assessmentOfferings)\/|^\/\.\.\/\.\.\/rostering\/v1p2\/(orgs|users|classes|courses|academicSessions)\//);
    }
  });
});

describe('mergeSwaggerFragment', () => {
  test('refuses a fragment that redefines a path or schema', () => {
    const document = { paths: { '/a': {} }, components: { schemas: { user: {} } } };

    expect(() => mergeSwaggerFragment(document, { paths: { '/a': {} } })).toThrow('OpenAPI fragment redefines: /a');
    expect(() => mergeSwaggerFragment(document, { components: { schemas: { user: {} } } })).toThrow('redefines: user');
  });
});
