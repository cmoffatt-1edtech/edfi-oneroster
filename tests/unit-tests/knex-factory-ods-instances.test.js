// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect, afterEach } from '@jest/globals';
import { knexManager } from '../../src/config/knex-factory.js';

// Knex connects lazily, so these instances never open a connection
const CONNECTION = 'host=localhost;port=5432;username=u;password=p;database=d';

describe('knexManager ODS instances', () => {
  afterEach(async () => {
    jest.useRealTimers();
    knexManager.removeAllListeners('ods-instance-registered');
    await knexManager.closeAll();
  });

  test('registers an instance for the refresh by default', () => {
    const registered = jest.fn();
    knexManager.on('ods-instance-registered', registered);

    const instance = knexManager.createOdsInstance('postgres', CONNECTION, '1', 'primary-key');

    expect(knexManager.getOdsInstances('postgres')).toEqual([instance]);
    expect(registered).toHaveBeenCalledTimes(1);
  });

  test('keeps a query-only instance out of the refresh', () => {
    const registered = jest.fn();
    knexManager.on('ods-instance-registered', registered);

    const replica = knexManager.createOdsInstance('postgres', CONNECTION, '1', 'replica-key', { refresh: false });

    expect(knexManager.createOdsInstance('postgres', CONNECTION, '1', 'replica-key', { refresh: false })).toBe(replica);
    expect(knexManager.getOdsInstances('postgres')).toEqual([]);
    expect(registered).not.toHaveBeenCalled();
  });

  test('retires an instance at once and destroys its pool after the grace period', () => {
    jest.useFakeTimers();
    const instance = knexManager.createOdsInstance('postgres', CONNECTION, '1', 'old-key');
    // knex.destroy() is read-only and delegates to client.destroy()
    const destroy = jest.spyOn(instance.client, 'destroy').mockResolvedValue();

    knexManager.retireOdsInstance('old-key', { graceMs: 1000 });

    expect(knexManager.getOdsInstances('postgres')).toEqual([]);
    expect(knexManager.createOdsInstance('postgres', CONNECTION, '1', 'old-key')).not.toBe(instance);
    expect(destroy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('ignores a key it does not hold', () => {
    expect(() => knexManager.retireOdsInstance('missing')).not.toThrow();
  });
});
