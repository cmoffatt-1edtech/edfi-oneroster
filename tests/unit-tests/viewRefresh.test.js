// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { refreshView } from '../../src/services/viewRefresh.js';

/**
 * A knex stand-in that answers the queries refreshView makes and records the statements it runs.
 * `tracking` is whether the data store has the change tracking; `version` / `complete` describe the
 * current sources; `state` is the recorded refresh_state row (or undefined).
 */
function fakeKnex({ tracking = true, version = '100', complete = true, state } = {}) {
  const statements = [];
  const answer = (sql, bindings) => {
    statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), bindings });
    if (sql.includes('to_regprocedure')) return { rows: [{ tracked: tracking }] };
    if (sql.includes('source_version(?)')) return { rows: [{ version, complete }] };
    if (sql.includes('FROM oneroster12.refresh_state')) return { rows: state ? [state] : [] };
    return { rows: [] };
  };
  const knex = {
    statements,
    raw: async (sql, bindings) => answer(sql, bindings),
    transaction: async work => {
      statements.push({ sql: 'BEGIN' });
      const result = await work({ raw: async (sql, bindings) => answer(sql, bindings) });
      statements.push({ sql: 'COMMIT' });
      return result;
    }
  };
  return knex;
}

const refreshes = knex => knex.statements.filter(s => s.sql.startsWith('REFRESH MATERIALIZED VIEW'));

describe('refreshView', () => {
  let platform;
  beforeEach(() => { platform = process.env.PLATFORM; });
  afterEach(() => {
    if (platform === undefined) delete process.env.PLATFORM; else process.env.PLATFORM = platform;
  });

  test('ODS/API: a plain refresh, with no probe for change tracking', async () => {
    delete process.env.PLATFORM;
    const knex = fakeKnex();
    await expect(refreshView(knex, 'users')).resolves.toEqual({ refreshed: true, tracked: false });
    expect(knex.statements.map(s => s.sql)).toEqual(['REFRESH MATERIALIZED VIEW oneroster12.users']);
  });

  describe('DMS', () => {
    beforeEach(() => { process.env.PLATFORM = 'dms'; });

    test('a data store without change tracking gets a plain refresh', async () => {
      const knex = fakeKnex({ tracking: false });
      await expect(refreshView(knex, 'users')).resolves.toEqual({ refreshed: true, tracked: false });
      expect(refreshes(knex)).toHaveLength(1);
      expect(knex.statements.some(s => s.sql === 'BEGIN')).toBe(false);
    });

    test('skips when the sources are no newer than a complete recorded state', async () => {
      const knex = fakeKnex({ version: '100', state: { version: '100', complete: true } });
      await expect(refreshView(knex, 'users')).resolves.toMatchObject({ refreshed: false, tracked: true, sourceVersion: '100' });
      expect(refreshes(knex)).toHaveLength(0);
    });

    test('refreshes and records the version when the sources moved, in one repeatable-read transaction', async () => {
      const knex = fakeKnex({ version: '101', state: { version: '100', complete: true } });
      await expect(refreshView(knex, 'users')).resolves.toMatchObject({ refreshed: true, sourceVersion: '101', complete: true });
      const sql = knex.statements.map(s => s.sql);
      const begin = sql.indexOf('BEGIN');
      expect(sql[begin + 1]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      expect(sql.indexOf('REFRESH MATERIALIZED VIEW oneroster12.users')).toBeLessThan(sql.indexOf('COMMIT'));
      const upsert = knex.statements.find(s => s.sql.startsWith('INSERT INTO oneroster12.refresh_state'));
      expect(upsert.bindings).toEqual(['users', '101', true]);
    });

    test('refreshes with no recorded state, and again after an incomplete one', async () => {
      const first = fakeKnex({ version: '100' });
      await expect(refreshView(first, 'orgs')).resolves.toMatchObject({ refreshed: true });
      const afterIncomplete = fakeKnex({ version: '100', state: { version: '100', complete: false } });
      await expect(refreshView(afterIncomplete, 'orgs')).resolves.toMatchObject({ refreshed: true });
    });

    test('records a version read while another write was in flight as incomplete', async () => {
      const knex = fakeKnex({ version: '120', complete: false, state: { version: '100', complete: true } });
      await refreshView(knex, 'orgs');
      const upsert = knex.statements.find(s => s.sql.startsWith('INSERT INTO oneroster12.refresh_state'));
      expect(upsert.bindings).toEqual(['orgs', '120', false]);
    });

    test('compares versions as numbers, not strings', async () => {
      const knex = fakeKnex({ version: '1000', state: { version: '999', complete: true } });
      await expect(refreshView(knex, 'orgs')).resolves.toMatchObject({ refreshed: true });
    });

    test('a view the deployed function does not know is refreshed untracked', async () => {
      const knex = fakeKnex({ version: null });
      await expect(refreshView(knex, 'orgs')).resolves.toEqual({ refreshed: true, tracked: false });
      expect(knex.statements.some(s => s.sql.startsWith('INSERT INTO'))).toBe(false);
    });
  });

  test('rejects a view name that is not a plain identifier', async () => {
    await expect(refreshView(fakeKnex(), 'users; drop table x')).rejects.toThrow('Invalid view name');
  });
});
