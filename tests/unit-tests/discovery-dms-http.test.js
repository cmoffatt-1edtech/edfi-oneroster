// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import dotenv from 'dotenv';
import express from 'express';

// Discovery over HTTP with the service environment of the DMS stack (stack/dms/.env.dms.5.2.0.example),
// which has no OAUTH2_ISSUERBASEURL: the ODS-only discovery code answered 500 there.

const mockIsTenant = jest.fn();
jest.unstable_mockModule('../../src/platform/data-store-provider.js', () => ({
  getDataStoreProvider: () => ({ isTenant: mockIsTenant })
}));

const { createDiscoveryRouter } = await import('../../src/routes/discovery.js');

const dmsExampleEnv = dotenv.parse(fs.readFileSync(new URL('../../stack/dms/.env.dms.5.2.0.example', import.meta.url)));
const ROSTER = 'ims/oneroster/rostering/v1p2/';
const BASE = 'https://oneroster.example.org';

/** GET a path from a fresh app with the discovery routes for the current environment. */
async function get(path) {
  const app = express();
  app.use('/', createDiscoveryRouter());
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'oneroster.example.org' }
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

describe('discovery on Ed-Fi API v8 (DMS), over HTTP', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    for (const name of ['OAUTH2_ISSUERBASEURL', 'ODS_CONTEXT_ROUTE_TEMPLATE', 'ROUTE_QUALIFIER_SEGMENTS',
      'ENABLE_SWAGGER_UI', 'ENABLE_OPEN_API_METADATA', 'API_BASE_PATH']) {
      delete process.env[name];
    }
    Object.assign(process.env, dmsExampleEnv);
    mockIsTenant.mockReset();
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => { if (!(k in originalEnv)) delete process.env[k]; });
    Object.assign(process.env, originalEnv);
  });

  test('answers the root with the DMS token URL in the documented stack configuration', async () => {
    const { status, body } = await get('/');

    expect(status).toBe(200);
    expect(body).toEqual({
      version: '1.0.0',
      urls: {
        openApiMetadata: `${BASE}/swagger.json`,
        swaggerUI: `${BASE}/docs`,
        oauth: dmsExampleEnv.OAUTH2_TOKEN_URL,
        dataManagementApi: `${BASE}/${ROSTER}`
      }
    });
  });

  test('falls back to the issuer token endpoint without OAUTH2_TOKEN_URL', async () => {
    delete process.env.OAUTH2_TOKEN_URL;
    const { body } = await get('/');
    expect(body.urls.oauth).toBe(`${dmsExampleEnv.OAUTH2_ISSUER}/connect/token`);
  });

  test('advertises assessment rostering after dataManagementApi when it is enabled', async () => {
    process.env.ASSESSMENT_ROSTERING_ENABLED = 'true';
    process.env.ROUTE_QUALIFIER_SEGMENTS = 'districtId';
    const { body } = await get('/255901');

    expect(body.urls.assessmentRosteringApi).toBe(`${BASE}/255901/ims/oneroster/assessmentRostering/v1p0/`);
    expect(Object.keys(body.urls).at(-1)).toBe('assessmentRosteringApi');
  });

  describe('with route qualifiers districtId,schoolYear', () => {
    beforeEach(() => {
      process.env.ROUTE_QUALIFIER_SEGMENTS = 'districtId,schoolYear';
    });

    test.each([
      ['/255901/2026', '255901/2026'],
      ['/255901', '255901/{schoolYear}'],
      ['/', '{districtId}/{schoolYear}']
    ])('GET %s fills the qualifiers it has and leaves placeholders for the rest', async (path, prefix) => {
      const { status, body } = await get(path);
      expect(status).toBe(200);
      expect(body.urls.dataManagementApi).toBe(`${BASE}/${prefix}/${ROSTER}`);
      expect(body.urls.openApiMetadata).toBe(`${BASE}/${prefix}/swagger.json`);
    });
  });

  describe('multi-tenant, with route qualifier schoolYear', () => {
    beforeEach(() => {
      process.env.MULTITENANCY_ENABLED = 'true';
      process.env.ROUTE_QUALIFIER_SEGMENTS = 'schoolYear';
      mockIsTenant.mockImplementation(async tenant => tenant === 'Tenant1');
    });

    test.each([
      ['/Tenant1/2026', 'Tenant1/2026'],
      ['/Tenant1', 'Tenant1/{schoolYear}'],
      ['/', '{tenantIdentifier}/{schoolYear}']
    ])('GET %s', async (path, prefix) => {
      const { status, body } = await get(path);
      expect(status).toBe(200);
      expect(body.urls.dataManagementApi).toBe(`${BASE}/${prefix}/${ROSTER}`);
    });

    test('answers 404 for an unknown tenant', async () => {
      expect((await get('/Nope')).status).toBe(404);
      expect((await get('/Nope/2026')).status).toBe(404);
    });

    test('answers 503 when the Configuration Service cannot be read', async () => {
      mockIsTenant.mockRejectedValue(new Error('CMS down'));
      const { status, body } = await get('/Tenant1');
      expect(status).toBe(503);
      expect(JSON.stringify(body)).not.toContain('CMS down');
    });
  });

  test('leaves the ODS discovery as it was', async () => {
    for (const name of Object.keys(dmsExampleEnv)) delete process.env[name];
    process.env.OAUTH2_ISSUERBASEURL = 'https://api.example.org';

    const { status, body } = await get('/');

    expect(status).toBe(200);
    expect(body.urls.oauth).toBe('https://api.example.org/oauth/token');
    expect(body.urls.dataManagementApi).toBe(`${BASE}/${ROSTER}`);
  });
});
