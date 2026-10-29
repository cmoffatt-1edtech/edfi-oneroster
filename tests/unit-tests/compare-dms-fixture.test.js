// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import { changedSequences, checkExpectations, fixtureRows, resolveTable } from '../compare-dms-fixture.js';
import { md5 } from '../dms-parity-fixture.js';

describe('fixtureRows', () => {
  const lea = { sourcedId: 'lea', children: [{ sourcedId: 'a' }, { sourcedId: 'b' }] };

  test('returns the rows the load added, ignoring array order in unchanged rows', () => {
    const reordered = { ...lea, children: [{ sourcedId: 'b' }, { sourcedId: 'a' }] };
    const added = { sourcedId: 'new' };
    expect(fixtureRows([lea], [added, reordered])).toEqual({ added: [added], removed: 0 });
  });

  test('a changed existing row counts as removed and comes back as added', () => {
    const changed = { ...lea, children: [...lea.children, { sourcedId: 'leak' }] };
    expect(fixtureRows([lea], [changed])).toEqual({ added: [changed], removed: 1 });
  });

  test('repeated rows are matched one for one', () => {
    const row = { sourcedId: 'x' };
    expect(fixtureRows([row], [row, row])).toEqual({ added: [row], removed: 0 });
    expect(fixtureRows([row, row], [row]).removed).toBe(1);
  });
});

describe('checkExpectations', () => {
  const row = (key, extra) => ({ sourcedId: md5(key), ...extra });

  test('passes when counts and values match, allowing order only where declared', () => {
    const added = { users: [row('u1', { roles: [1, 2], ids: [1, 2] })] };
    const expectations = [{ view: 'users', key: 'u1', values: { roles: [2, 1], ids: [1, 2] }, unordered: ['roles'] }];
    expect(checkExpectations(added, expectations, { users: 1 })).toEqual({ checked: 2, failures: [] });
  });

  test('reports a wrong count, a missing row, an unexpected row and wrong values', () => {
    const added = { users: [row('u1', { email: 'a', ids: [1, 2] }), row('u2', {})] };
    const expectations = [
      { view: 'users', key: 'u1', values: { email: 'b', ids: [2, 1] } },
      { view: 'users', key: 'u3', values: { email: null } },
      { view: 'users', key: 'u2', absent: true },
      { view: 'orgs', id: 'raw-id', values: {} }
    ];
    const { failures } = checkExpectations(added, expectations, { users: 3 });
    expect(failures).toEqual([
      'users: 2 fixture rows, expected 3',
      'users u1 email: "a", expected "b"',
      'users u1 ids: [1,2], expected [2,1]',
      'users u3: no row',
      'users u2: present, expected no row',
      'orgs raw-id: no row'
    ]);
  });

  test('compares timestamps as instants', () => {
    const added = { orgs: [row('o', { dateLastModified: new Date('2026-02-01T08:00:00Z') })] };
    const ok = checkExpectations(added, [{ view: 'orgs', key: 'o', values: { dateLastModified: new Date('2026-02-01T08:00:00.000Z') } }], {});
    const late = checkExpectations(added, [{ view: 'orgs', key: 'o', values: { dateLastModified: new Date('2026-02-01T08:00:01Z') } }], {});
    expect(ok.failures).toEqual([]);
    expect(late.failures).toHaveLength(1);
  });
});

describe('resolveTable', () => {
  const nameMap = { tables: { 'Ed-Fi/Thing/$.items[*]': { schema: 'edfi', name: 'ThingItem_abc' } } };

  test('splits schema.name', () => {
    expect(resolveTable('edfi.Student', null)).toEqual({ schema: 'edfi', name: 'Student' });
  });

  test('resolves a placeholder through the name map, and fails on an unknown one', () => {
    expect(resolveTable('{{table:Ed-Fi/Thing/$.items[*]}}', nameMap)).toEqual({ schema: 'edfi', name: 'ThingItem_abc' });
    expect(() => resolveTable('{{table:Ed-Fi/Other/$.x[*]}}', nameMap)).toThrow('No name-map entry');
  });
});

describe('changedSequences', () => {
  test('lists sequences whose last value moved, appeared or disappeared', () => {
    const before = new Map([['a', '1'], ['b', '5'], ['c', null]]);
    const after = new Map([['a', '1'], ['b', '6'], ['c', null], ['d', '1']]);
    expect(changedSequences(before, after)).toEqual(['b', 'd']);
  });
});
