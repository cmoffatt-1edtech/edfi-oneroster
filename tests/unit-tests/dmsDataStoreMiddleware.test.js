// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect } from '@jest/globals';
import {
  isRouteContextMatch,
  matchDataStores,
  createDmsDataStoreMiddleware
} from '../../src/middleware/dmsDataStoreMiddleware.js';

const store = (id, contexts = {}) => ({ id: String(id), name: `ds${id}`, contexts });

function createProvider(lists, overrides = {}) {
  const queue = [...lists];
  return {
    listDataStores: jest.fn(async () => (queue.length > 1 ? queue.shift() : queue[0])),
    isTenant: jest.fn(async tenant => tenant.toLowerCase() === 'tenant1'),
    isClientBoundToTenant: jest.fn(async clientId => clientId === 'bound-client'),
    ...overrides
  };
}

function run(middleware, { params = {}, payload = { client_id: 'bound-client', dataStoreIds: '1' } } = {}) {
  const req = { params, auth: { payload } };
  const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  return middleware(req, res, next).then(() => ({ req, res, next }));
}

describe('DMS route context matching (DMS RouteContextMatcher)', () => {
  test.each([
    [{}, {}, true],
    [{ schoolYear: '2026' }, {}, false],
    [{}, { schoolYear: '2026' }, false],
    [{ schoolYear: '2026' }, { schoolYear: '2026' }, true],
    [{ SchoolYear: 'ABC' }, { schoolyear: 'abc' }, true],
    [{ schoolYear: '2026' }, { schoolYear: '2027' }, false],
    [{ districtId: '255901', schoolYear: '2026' }, { schoolYear: '2026', districtId: '255901' }, true],
    [{ districtId: '255901', schoolYear: '2026' }, { districtId: '255901', term: '2026' }, false]
  ])('contexts %p against qualifiers %p -> %p', (contexts, qualifiers, expected) => {
    expect(isRouteContextMatch(contexts, qualifiers)).toBe(expected);
  });

  test('only considers the data stores the token authorizes', () => {
    const stores = [store(1, { schoolYear: '2026' }), store(2, { schoolYear: '2026' })];
    expect(matchDataStores(stores, ['2'], { schoolYear: '2026' }).map(ds => ds.id)).toEqual(['2']);
  });
});

describe('createDmsDataStoreMiddleware', () => {
  test('routes a single-tenant request without qualifiers to the one data store', async () => {
    const middleware = createDmsDataStoreMiddleware({ provider: createProvider([[store(1)]]), multiTenancyEnabled: false, routeContext: null });
    const { req, next, res } = await run(middleware);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.odsInstanceId).toBe('1');
    expect(req.odsCacheKey).toBe('datastore-1');
    expect(req.tenantId).toBeNull();
  });

  test('passes on the data store connection version, so a changed connection replaces the service', async () => {
    const middleware = createDmsDataStoreMiddleware({
      provider: createProvider([[{ ...store(1), connectionVersion: 'abc123' }]]), multiTenancyEnabled: false, routeContext: null
    });
    const { req } = await run(middleware);

    expect(req.odsConnectionVersion).toBe('abc123');
  });

  test('answers 403 when the token authorizes no data stores', async () => {
    const middleware = createDmsDataStoreMiddleware({ provider: createProvider([[store(1)]]), multiTenancyEnabled: false, routeContext: null });
    const { res, next } = await run(middleware, { payload: { dataStoreIds: '' } });

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ imsx_description: 'No data stores are authorized for this client.' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('selects the data store whose contexts match the route qualifiers', async () => {
    const stores = [store(1, { schoolYear: '2026' }), store(2, { schoolYear: '2027' })];
    const middleware = createDmsDataStoreMiddleware({
      provider: createProvider([stores]), multiTenancyEnabled: false, routeContext: { parameterNames: ['schoolYear'] }
    });
    const { req, next } = await run(middleware, { params: { schoolYear: '2027' }, payload: { dataStoreIds: '1,2' } });

    expect(next).toHaveBeenCalled();
    expect(req.odsInstanceId).toBe('2');
  });

  test('reloads once on no match, then answers 404', async () => {
    const provider = createProvider([[store(1, { schoolYear: '2026' })]]);
    const middleware = createDmsDataStoreMiddleware({ provider, multiTenancyEnabled: false, routeContext: { parameterNames: ['schoolYear'] } });
    const { res } = await run(middleware, { params: { schoolYear: '2030' } });

    expect(provider.listDataStores).toHaveBeenCalledTimes(2);
    expect(provider.listDataStores).toHaveBeenLastCalledWith(null, { reload: true });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('finds a data store added since the last load', async () => {
    const provider = createProvider([[store(1)], [store(1), store(5)]]);
    const middleware = createDmsDataStoreMiddleware({ provider, multiTenancyEnabled: false, routeContext: null });
    const { req, next } = await run(middleware, { payload: { dataStoreIds: '5' } });

    expect(next).toHaveBeenCalled();
    expect(req.odsInstanceId).toBe('5');
  });

  test('answers 400 when more than one authorized data store matches', async () => {
    const middleware = createDmsDataStoreMiddleware({ provider: createProvider([[store(1), store(2)]]), multiTenancyEnabled: false, routeContext: null });
    const { res } = await run(middleware, { payload: { dataStoreIds: '1,2' } });

    expect(res.status).toHaveBeenCalledWith(400);
  });

  describe('multi-tenant', () => {
    const multiTenant = provider => createDmsDataStoreMiddleware({ provider, multiTenancyEnabled: true, routeContext: null });

    test('routes within the tenant and keys the cache by tenant', async () => {
      const provider = createProvider([[store(1)]]);
      const { req, next } = await run(multiTenant(provider), { params: { tenantId: 'Tenant1' } });

      expect(next).toHaveBeenCalled();
      expect(provider.isClientBoundToTenant).toHaveBeenCalledWith('bound-client', 'Tenant1');
      expect(provider.listDataStores).toHaveBeenCalledWith('Tenant1');
      expect(req.tenantId).toBe('Tenant1');
      expect(req.odsCacheKey).toBe('tenant-Tenant1-datastore-1');
    });

    test('answers 404 for an unknown or missing tenant', async () => {
      expect((await run(multiTenant(createProvider([[store(1)]])), { params: { tenantId: 'Nope' } })).res.status).toHaveBeenCalledWith(404);
      expect((await run(multiTenant(createProvider([[store(1)]])), { params: {} })).res.status).toHaveBeenCalledWith(404);
    });

    test('answers 401 when the client is not bound to the tenant', async () => {
      const { res, next } = await run(multiTenant(createProvider([[store(1)]])), {
        params: { tenantId: 'Tenant1' }, payload: { client_id: 'other-client', dataStoreIds: '1' }
      });

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  test('answers 503 without details when the Configuration Service fails', async () => {
    const provider = createProvider([[store(1)]], { listDataStores: jest.fn(async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:8081'); }) });
    const middleware = createDmsDataStoreMiddleware({ provider, multiTenancyEnabled: false, routeContext: null });
    const { res } = await run(middleware);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('ECONNREFUSED');
  });
});
