// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect, beforeEach } from '@jest/globals';

// A Knex stand-in that passes the factory's connection and schema checks
const fakeKnex = name => ({ name, raw: jest.fn(async () => ({ rows: [{ count: 1 }] })) });

const mockKnexManager = {
  createOdsInstance: jest.fn((dbType, connectionString) => fakeKnex(connectionString)),
  retireOdsInstance: jest.fn()
};
let mockProvider;

jest.unstable_mockModule('../../src/config/knex-factory.js', () => ({ knexManager: mockKnexManager }));
jest.unstable_mockModule('../../src/platform/data-store-provider.js', () => ({
  getDataStoreProvider: () => mockProvider
}));

const { DatabaseServiceFactory } = await import('../../src/services/database/DatabaseServiceFactory.js');

/** A DMS-shaped provider; the connection strings it returns can be changed between calls. */
function dmsProvider({ query = 'host=replica', refresh = 'host=primary' } = {}) {
  const provider = {
    query,
    refresh,
    resolveConnectionString: jest.fn(async () => provider.query),
    resolveRefreshConnectionString: jest.fn(async () => provider.refresh)
  };
  return provider;
}

describe('DatabaseServiceFactory', () => {
  let factory;

  beforeEach(() => {
    jest.clearAllMocks();
    factory = new DatabaseServiceFactory();
  });

  test('ODS: one Knex instance, registered for the refresh as before', async () => {
    mockProvider = { resolveConnectionString: jest.fn(async () => 'host=ods') };

    await factory.createServiceForType('postgres', 'oneroster12', null, '2', 'ods-key');

    expect(mockKnexManager.createOdsInstance).toHaveBeenCalledTimes(1);
    expect(mockKnexManager.createOdsInstance).toHaveBeenCalledWith('postgres', 'host=ods', '2', 'ods-key', { refresh: true });
  });

  test('DMS read replica: queries use the replica, and only the primary is refreshed', async () => {
    mockProvider = dmsProvider();

    const service = await factory.createServiceForType('postgres', 'oneroster12', null, '1', 'datastore-1', 'v1');

    expect(service.knex.name).toBe('host=replica');
    expect(mockKnexManager.createOdsInstance.mock.calls).toEqual([
      ['postgres', 'host=replica', '1', 'datastore-1', { refresh: false }],
      ['postgres', 'host=primary', '1', 'datastore-1-refresh']
    ]);
  });

  test('DMS without a replica: the query instance is the refresh instance', async () => {
    mockProvider = dmsProvider({ query: 'host=primary', refresh: null });

    await factory.createServiceForType('postgres', 'oneroster12', null, '1', 'datastore-1', 'v1');

    expect(mockKnexManager.createOdsInstance.mock.calls).toEqual([
      ['postgres', 'host=primary', '1', 'datastore-1', { refresh: true }]
    ]);
  });

  test('reuses the service while the connection version is the same', async () => {
    mockProvider = dmsProvider();

    const first = await factory.createServiceForType('postgres', 'oneroster12', null, '1', 'datastore-1', 'v1');
    const second = await factory.createServiceForType('postgres', 'oneroster12', null, '1', 'datastore-1', 'v1');

    expect(second).toBe(first);
    expect(mockProvider.resolveConnectionString).toHaveBeenCalledTimes(1);
    expect(mockKnexManager.retireOdsInstance).not.toHaveBeenCalled();
  });

  test('replaces the service and retires its pools when the connection version changes', async () => {
    mockProvider = dmsProvider();
    const first = await factory.createServiceForType('postgres', 'oneroster12', null, '1', 'datastore-1', 'v1');

    mockProvider.query = 'host=new-replica';
    mockProvider.refresh = 'host=new-primary';
    const second = await factory.createServiceForType('postgres', 'oneroster12', null, '1', 'datastore-1', 'v2');

    expect(second).not.toBe(first);
    expect(second.knex.name).toBe('host=new-replica');
    expect(mockKnexManager.retireOdsInstance.mock.calls).toEqual([['datastore-1'], ['datastore-1-refresh']]);
    expect(mockKnexManager.createOdsInstance).toHaveBeenLastCalledWith('postgres', 'host=new-primary', '1', 'datastore-1-refresh');
  });
});
