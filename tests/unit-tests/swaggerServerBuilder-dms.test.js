// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import express from 'express';
import { buildDmsSwaggerServers } from '../../src/services/swaggerServerBuilder.js';

const BASE = 'https://api.example.org/oneroster';

/** A provider with data stores per tenant (null = single tenant). */
function fakeProvider(byTenant, tenants = Object.keys(byTenant).filter(t => t !== 'null')) {
  return {
    listTenants: async () => tenants,
    listDataStores: async tenant => byTenant[String(tenant)] || []
  };
}

describe('buildDmsSwaggerServers', () => {
  test('single tenant, no qualifiers: the base URL only', async () => {
    await expect(buildDmsSwaggerServers(BASE, { provider: fakeProvider({}), multiTenancyEnabled: false, qualifierNames: [] }))
      .resolves.toEqual([{ url: BASE }]);
  });

  test('qualifiers: one choice per data store with exactly those contexts, in qualifier order', async () => {
    const provider = fakeProvider({
      null: [
        { id: '1', contexts: { schoolYear: '2026', DistrictId: '255901' } },
        { id: '2', contexts: { districtid: '255901', schoolyear: '2025' } },
        { id: '3', contexts: { schoolYear: '2024' } }, // missing districtId: not routable
        { id: '4', contexts: { districtId: '1', schoolYear: '2026', extra: 'x' } } // extra key: not routable
      ]
    });
    const [server] = await buildDmsSwaggerServers(BASE, { provider, multiTenancyEnabled: false, qualifierNames: ['districtId', 'schoolYear'] });
    expect(server.url).toBe(`${BASE}/{Context Selection}`);
    expect(server.variables['Context Selection']).toEqual({
      default: '255901/2025', enum: ['255901/2025', '255901/2026'], description: 'Context Selection'
    });
  });

  test("multi-tenant: tenants alone, or each tenant with its data stores' qualifier values", async () => {
    const provider = fakeProvider({
      Tenant1: [{ id: '1', contexts: { schoolYear: '2026' } }],
      Tenant2: [{ id: '1', contexts: { schoolYear: '2025' } }, { id: '2', contexts: { schoolYear: '2026' } }]
    });
    const [tenantsOnly] = await buildDmsSwaggerServers(BASE, { provider, multiTenancyEnabled: true, qualifierNames: [] });
    expect(tenantsOnly.url).toBe(`${BASE}/{Tenant Selection}`);
    expect(tenantsOnly.variables['Tenant Selection'].enum).toEqual(['Tenant1', 'Tenant2']);

    const [withContexts] = await buildDmsSwaggerServers(BASE, { provider, multiTenancyEnabled: true, qualifierNames: ['schoolYear'] });
    expect(withContexts.url).toBe(`${BASE}/{Tenant/Context Selection}`);
    expect(withContexts.variables['Tenant/Context Selection'].enum).toEqual(['Tenant1/2026', 'Tenant2/2025', 'Tenant2/2026']);
  });

  test('percent-encodes each tenant and qualifier value, keeping the separators', async () => {
    const provider = fakeProvider({
      'North#1': [{ id: '1', contexts: { schoolYear: '2026/2027' } }, { id: '2', contexts: { schoolYear: 'a?b=1' } }]
    });
    const [tenantsOnly] = await buildDmsSwaggerServers(BASE, { provider, multiTenancyEnabled: true, qualifierNames: [] });
    expect(tenantsOnly.variables['Tenant Selection'].enum).toEqual(['North%231']);

    const [withContexts] = await buildDmsSwaggerServers(BASE, { provider, multiTenancyEnabled: true, qualifierNames: ['schoolYear'] });
    expect(withContexts.variables['Tenant/Context Selection'].enum).toEqual(['North%231/2026%2F2027', 'North%231/a%3Fb%3D1']);
  });

  // The route parameters dmsDataStoreMiddleware matches are the decoded values
  test('an encoded choice reaches Express as the original values', async () => {
    const provider = fakeProvider({ 'North#1': [{ id: '1', contexts: { schoolYear: '2026/2027' } }] });
    const [server] = await buildDmsSwaggerServers('', { provider, multiTenancyEnabled: true, qualifierNames: ['schoolYear'] });
    const app = express();
    app.use('/:tenantId/:schoolYear/ims/oneroster', (req, res) => res.json(req.params));
    const listener = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const prefix = server.variables['Tenant/Context Selection'].enum[0];
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/${prefix}/ims/oneroster/rostering/v1p2/orgs`);
      expect(await response.json()).toEqual({ tenantId: 'North#1', schoolYear: '2026/2027' });
    } finally {
      await new Promise(resolve => listener.close(resolve));
    }
  });

  test('falls back to the base URL when nothing is routable or the Configuration Service fails', async () => {
    const empty = fakeProvider({ null: [{ id: '1', contexts: {} }] });
    await expect(buildDmsSwaggerServers(BASE, { provider: empty, multiTenancyEnabled: false, qualifierNames: ['schoolYear'] }))
      .resolves.toEqual([{ url: BASE }]);
    const failing = { listTenants: async () => { throw new Error('down'); }, listDataStores: async () => [] };
    await expect(buildDmsSwaggerServers(BASE, { provider: failing, multiTenancyEnabled: true, qualifierNames: [] }))
      .resolves.toEqual([{ url: BASE }]);
  });
});
