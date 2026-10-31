// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';

// The assessment rostering routes and controller over HTTP, with the database service mocked.
const mockQueryMany = jest.fn();
const mockQueryOne = jest.fn();
jest.unstable_mockModule('../../src/services/database/DatabaseServiceFactory.js', () => ({
  getDefaultDatabaseService: async () => ({ queryMany: mockQueryMany, queryOne: mockQueryOne })
}));

const { default: assessmentRosteringRoutes } = await import('../../src/routes/assessmentRostering.js');
const { default: oneRosterRoutes } = await import('../../src/routes/oneRoster.js');
const { isAssessmentRosteringEnabled, ASSESSMENT_VIEWS, ASSESSMENT_ROSTERING_BASE_PATH } =
  await import('../../src/config/assessment-rostering.js');

const ROSTER_SCOPE = 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly';
const CORE_SCOPE = 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly';
const DEMOGRAPHICS_SCOPE = 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster-demographics.readonly';
const BASE = `/ims/oneroster${ASSESSMENT_ROSTERING_BASE_PATH}`;

/** GET a path from an app mounted the way src/app.js mounts it (with the flag on or off). */
async function get(path, { enabled = true, scope = ROSTER_SCOPE } = {}) {
  const app = express();
  app.use((req, res, next) => {
    req.auth = { payload: { scope, educationOrganizationId: '255901001' } };
    req.odsInstanceId = 1;
    next();
  });
  app.use('/ims/oneroster', ...(enabled ? [assessmentRosteringRoutes] : []), oneRosterRoutes);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('assessment rostering configuration', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = process.env.ASSESSMENT_ROSTERING_ENABLED; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ASSESSMENT_ROSTERING_ENABLED;
    else process.env.ASSESSMENT_ROSTERING_ENABLED = originalEnv;
  });

  test('is off unless ASSESSMENT_ROSTERING_ENABLED is true', () => {
    delete process.env.ASSESSMENT_ROSTERING_ENABLED;
    expect(isAssessmentRosteringEnabled()).toBe(false);
    process.env.ASSESSMENT_ROSTERING_ENABLED = 'false';
    expect(isAssessmentRosteringEnabled()).toBe(false);
    process.env.ASSESSMENT_ROSTERING_ENABLED = ' TRUE ';
    expect(isAssessmentRosteringEnabled()).toBe(true);
  });

  test('names four views, all valid refresh names', () => {
    expect(ASSESSMENT_VIEWS).toEqual(['assessments', 'assessmentofferings', 'assessmentenrollments', 'assessmentauthorgs']);
    ASSESSMENT_VIEWS.forEach(view => expect(view).toMatch(/^[a-z]+$/));
  });
});

describe('assessment rostering routes', () => {
  beforeEach(() => {
    mockQueryMany.mockReset().mockResolvedValue([{ sourcedId: 'a' }]);
    mockQueryOne.mockReset().mockResolvedValue({ sourcedId: 'a' });
  });

  test.each([
    ['assessments', 'assessments', 'assessments'],
    ['assessmentOfferings', 'assessmentofferings', 'assessmentOfferings'],
    ['assessmentEnrollments', 'assessmentenrollments', 'assessmentEnrollments']
  ])('GET %s queries the %s view and wraps the collection as %s', async (path, view, wrapper) => {
    const { status, body } = await get(`${BASE}/${path}?limit=5`);

    expect(status).toBe(200);
    expect(body).toEqual({ [wrapper]: [{ sourcedId: 'a' }] });
    const [endpoint, config, query, extraWhere, edOrgIds] = mockQueryMany.mock.calls[0];
    expect(endpoint).toBe(view);
    expect(query).toEqual({ limit: '5' });
    expect(extraWhere).toBeNull();
    expect(edOrgIds).toEqual(['255901001']);
    expect(config.selectableFields).not.toEqual(expect.arrayContaining(['educationOrganizationId']));
  });

  test.each([
    ['assessments', 'assessment'],
    ['assessmentOfferings', 'assessmentOffering'],
    ['assessmentEnrollments', 'assessmentEnrollment']
  ])('GET %s/{id} wraps the record as %s', async (path, wrapper) => {
    const { status, body } = await get(`${BASE}/${path}/abc`);

    expect(status).toBe(200);
    expect(body).toEqual({ [wrapper]: { sourcedId: 'a' } });
    expect(mockQueryOne.mock.calls[0][1]).toBe('abc');
  });

  test('hidden columns are neither selectable nor filterable', async () => {
    await get(`${BASE}/assessments`);
    await get(`${BASE}/assessmentOfferings`);
    await get(`${BASE}/assessmentEnrollments`);
    const hidden = ['educationOrganizationId', 'definingEducationOrganizationId', 'assessmentSourcedId',
      'assessmentOfferingSourcedId', 'participantUSI', 'participantDocumentId'];
    for (const [, config] of mockQueryMany.mock.calls) {
      expect(config.selectableFields.filter(field => hidden.includes(field))).toEqual([]);
      expect(config.allowedFilterFields.filter(field => hidden.includes(field))).toEqual([]);
    }
  });

  describe('sub-collections', () => {
    test('enrollments of an offering: the parent is checked, then the bound parent id filters the children', async () => {
      const { status, body } = await get(`${BASE}/assessmentOfferings/off-1/assessmentEnrollments?filter=role%3D'student'`);

      expect(status).toBe(200);
      expect(body).toEqual({ assessmentEnrollments: [{ sourcedId: 'a' }] });
      expect(mockQueryOne).toHaveBeenCalledWith('assessmentofferings', 'off-1', null, ['255901001'], ['sourcedId']);
      const [endpoint, , query, extraWhere] = mockQueryMany.mock.calls[0];
      expect(endpoint).toBe('assessmentenrollments');
      expect(query).toEqual({ filter: "role='student'" });
      expect(extraWhere).toEqual({ assessmentOfferingSourcedId: 'off-1' });
    });

    test('offerings of an assessment', async () => {
      const { status, body } = await get(`${BASE}/assessments/asmt-1/assessmentOfferings`);

      expect(status).toBe(200);
      expect(body).toEqual({ assessmentOfferings: [{ sourcedId: 'a' }] });
      expect(mockQueryOne.mock.calls[0][0]).toBe('assessments');
      expect(mockQueryMany.mock.calls[0][3]).toEqual({ assessmentSourcedId: 'asmt-1' });
    });

    test('an unknown or invisible parent answers 404 without querying the children', async () => {
      mockQueryOne.mockResolvedValue(null);
      const { status, body } = await get(`${BASE}/assessmentOfferings/nope/assessmentEnrollments`);

      expect(status).toBe(404);
      expect(body.imsx_description).toBe('Resource not found: assessmentofferings/nope');
      expect(mockQueryMany).not.toHaveBeenCalled();
    });

    test('a parent id with SQL in it is only ever a bound value', async () => {
      const id = "x' or '1'='1";
      await get(`${BASE}/assessments/${encodeURIComponent(id)}/assessmentOfferings`);

      expect(mockQueryMany.mock.calls[0][3]).toEqual({ assessmentSourcedId: id });
    });
  });

  describe('a data store without the assessment views', () => {
    test.each([
      ['PostgreSQL', Object.assign(new Error('relation "oneroster12.assessments" does not exist'), { code: '42P01' })],
      ['SQL Server', Object.assign(new Error("Invalid object name 'oneroster12.assessments'."), { number: 208 })],
      ['SQL Server (wrapped)', Object.assign(new Error('Invalid object name'), { originalError: { info: { number: 208 } } })]
    ])('%s: collections and single records answer the not-available 404', async (engine, error) => {
      mockQueryMany.mockRejectedValue(error);
      mockQueryOne.mockRejectedValue(error);

      for (const path of ['assessments', 'assessments/abc']) {
        const { status, body } = await get(`${BASE}/${path}`);
        expect(status).toBe(404);
        expect(body).toEqual({
          imsx_codeMajor: 'failure',
          imsx_severity: 'error',
          imsx_description: 'Assessment rostering is not available for this data store.',
          imsx_codeMinor: 'unknownobject'
        });
      }
    });

    test('a sub-collection whose parent view is missing answers the same 404', async () => {
      mockQueryOne.mockRejectedValue(Object.assign(new Error('missing'), { code: '42P01' }));
      const { status, body } = await get(`${BASE}/assessmentOfferings/x/assessmentEnrollments`);

      expect(status).toBe(404);
      expect(body.imsx_description).toBe('Assessment rostering is not available for this data store.');
    });

    test('other database errors stay a 500 without detail', async () => {
      mockQueryMany.mockRejectedValue(Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }));
      const { status, body } = await get(`${BASE}/assessments`);

      expect(status).toBe(500);
      expect(body.imsx_description).toBe('An internal server error occurred');
    });

    test('a missing view on a rostering endpoint is still a 500, as before', async () => {
      mockQueryMany.mockRejectedValue(Object.assign(new Error('missing'), { code: '42P01' }));
      const { status } = await get('/ims/oneroster/rostering/v1p2/orgs');

      expect(status).toBe(500);
    });
  });

  describe('scopes', () => {
    test('roster-core.readonly is enough', async () => {
      const { status } = await get(`${BASE}/assessmentEnrollments`, { scope: CORE_SCOPE });
      expect(status).toBe(200);
    });

    test('a token with neither rostering scope gets 403', async () => {
      const { status, body } = await get(`${BASE}/assessmentEnrollments`, { scope: DEMOGRAPHICS_SCOPE });
      expect(status).toBe(403);
      expect(body.imsx_description).toMatch(/^Insufficient scope/);
      expect(mockQueryMany).not.toHaveBeenCalled();
    });
  });

  describe('with the flag off', () => {
    test.each(['assessments', 'assessmentOfferings/x', 'assessmentOfferings/x/assessmentEnrollments'])(
      '%s falls through to the rostering router\'s 404', async path => {
        const { status, body } = await get(`${BASE}/${path}`, { enabled: false });

        expect(status).toBe(404);
        expect(body).toEqual({
          imsx_codeMajor: 'failure',
          imsx_severity: 'error',
          imsx_description: 'The specified resource was not found'
        });
        expect(mockQueryMany).not.toHaveBeenCalled();
      });

    test('rostering endpoints are unaffected either way', async () => {
      for (const enabled of [true, false]) {
        const { status, body } = await get('/ims/oneroster/rostering/v1p2/orgs', { enabled });
        expect(status).toBe(200);
        expect(body).toEqual({ orgs: [{ sourcedId: 'a' }] });
      }
    });
  });

  test('an unknown path under the assessment base falls through to the rostering 404', async () => {
    const { status } = await get(`${BASE}/assessmentResults`);
    expect(status).toBe(404);
  });
});
