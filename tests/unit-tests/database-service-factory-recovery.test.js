// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// The factory with the real knexManager cache: a connection corrected in the Configuration Service
// must reach the service even after a connection check failed. Knex connects lazily, and the
// connection check is replaced, so nothing opens a connection.

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

let mockProvider;
jest.unstable_mockModule('../../src/platform/data-store-provider.js', () => ({
  getDataStoreProvider: () => mockProvider
}));

const { knexManager } = await import('../../src/config/knex-factory.js');
const { DatabaseServiceFactory } = await import('../../src/services/database/DatabaseServiceFactory.js');

const connection = host => `host=${host};port=5432;username=u;password=p;database=d`;
const hostOf = knexInstance => knexInstance.client.config.connection.host;

/** Data store whose hosts can change between calls; refresh null means no read replica. */
function provider(query, refresh = null) {
  const p = {
    query,
    refresh,
    resolveConnectionString: async () => connection(p.query),
    resolveRefreshConnectionString: async () => (p.refresh ? connection(p.refresh) : null)
  };
  return p;
}

/** A factory whose connection check fails for the hosts in `unreachable`, recording each host checked. */
function factoryWith(unreachable) {
  const factory = new DatabaseServiceFactory();
  factory.checked = [];
  factory.testConnection = async knexInstance => {
    factory.checked.push(hostOf(knexInstance));
    if (unreachable.has(hostOf(knexInstance))) throw new Error('connection refused');
  };
  return factory;
}

const create = (factory, version) => factory.createServiceForType('postgres', 'oneroster12', null, '1', 'datastore-1', version);

describe('DatabaseServiceFactory recovery (real Knex cache)', () => {
  beforeEach(() => {
    const retire = knexManager.retireOdsInstance.bind(knexManager);
    jest.spyOn(knexManager, 'retireOdsInstance').mockImplementation(key => retire(key, { graceMs: 0 }));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    knexManager.removeAllListeners('ods-instance-registered');
    await knexManager.closeAll();
  });

  test('a failed first connection is replaced once the settings are corrected', async () => {
    mockProvider = provider('invalid-initial');
    const factory = factoryWith(new Set(['invalid-initial']));

    await expect(create(factory, 'v1')).rejects.toThrow('connection refused');
    mockProvider.query = 'corrected-target';
    const service = await create(factory, 'v2');

    expect(factory.checked).toEqual(['invalid-initial', 'corrected-target']);
    expect(hostOf(service.knex)).toBe('corrected-target');
    expect(knexManager.getOdsInstances('postgres').map(hostOf)).toEqual(['corrected-target']);
  });

  test('a working service survives a bad rotation once the settings are corrected', async () => {
    mockProvider = provider('good');
    const factory = factoryWith(new Set(['rotated-bad']));

    await create(factory, 'v1');
    mockProvider.query = 'rotated-bad';
    await expect(create(factory, 'v2')).rejects.toThrow('connection refused');
    mockProvider.query = 'corrected';
    const service = await create(factory, 'v3');

    expect(factory.checked).toEqual(['good', 'rotated-bad', 'corrected']);
    expect(hostOf(service.knex)).toBe('corrected');
  });

  test('the separate refresh pool on the primary is replaced too', async () => {
    mockProvider = provider('replica-bad', 'primary-bad');
    const factory = factoryWith(new Set(['replica-bad']));

    await expect(create(factory, 'v1')).rejects.toThrow('connection refused');
    mockProvider.query = 'replica';
    mockProvider.refresh = 'primary';
    await create(factory, 'v2');

    // Only the primary is registered for the refresh, and only the corrected one
    expect(knexManager.getOdsInstances('postgres').map(hostOf)).toEqual(['primary']);
  });

  test('a retry with unchanged settings reuses the pool', async () => {
    mockProvider = provider('down');
    const factory = factoryWith(new Set(['down']));

    await expect(create(factory, 'v1')).rejects.toThrow('connection refused');
    const pool = knexManager.getOdsInstances('postgres')[0];
    await expect(create(factory, 'v1')).rejects.toThrow('connection refused');

    expect(knexManager.retireOdsInstance).not.toHaveBeenCalled();
    expect(knexManager.getOdsInstances('postgres')).toEqual([pool]);
  });
});
