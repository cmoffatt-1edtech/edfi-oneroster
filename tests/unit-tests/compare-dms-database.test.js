// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import { compareRows, unexplainedCount, compareValues } from '../compare-dms-database.js';

const org = (sourcedId, extra = {}) => ({ sourcedId, name: `Org ${sourcedId}`, educationOrganizationId: 1, ...extra });

describe('compareRows / unexplainedCount', () => {
  test('identical rows pass, ignoring dateLastModified and the person keys', () => {
    const result = compareRows(
      [org('a', { dateLastModified: 1, participantUSI: 7 })],
      [org('a', { dateLastModified: 2, participantDocumentId: 9 })]
    );
    expect(result.identical).toBe(1);
    expect(unexplainedCount(result)).toBe(0);
  });

  test('a sourcedId repeated on DMS fails, though every value matches', () => {
    const result = compareRows([org('a')], [org('a'), org('a')]);
    expect(result.duplicateSourcedIds).toEqual({ ods: 0, dms: 1 });
    expect(result.duplicateIds.dms).toEqual(['a']);
    expect(unexplainedCount(result)).toBe(1);
  });

  test('a sourcedId repeated on the ODS fails too', () => {
    expect(unexplainedCount(compareRows([org('a'), org('a')], [org('a')]))).toBe(1);
  });

  test('a column missing on DMS fails', () => {
    const result = compareRows([org('a', { title: 'x' })], [org('a')]);
    expect(result.columnsOnlyOds).toEqual(['title']);
    expect(unexplainedCount(result)).toBe(1);
  });

  test('a column found only in a later row still counts', () => {
    const result = compareRows([org('a'), org('b', { title: 'x' })], [org('a'), org('b')]);
    expect(result.columnsOnlyOds).toEqual(['title']);
  });

  test('catalog columns check the schema of empty views', () => {
    const result = compareRows([], [], { columns: { ods: ['sourcedId', 'title'], dms: ['sourcedId', 'extra'] } });
    expect(result.columnsOnlyOds).toEqual(['title']);
    expect(result.columnsOnlyDms).toEqual(['extra']);
    expect(unexplainedCount(result)).toBe(2);
  });

  test('type differences count, order-only array differences do not', () => {
    const result = compareRows([org('a', { orgs: [1, 2] })], [org('a', { orgs: [2, 1] })]);
    expect(result.orderOnly).toEqual({ orgs: 1 });
    expect(unexplainedCount(result)).toBe(0);
    expect(unexplainedCount({ ...result, typeDiffs: ['name: text -> varchar'] })).toBe(1);
  });

  test('excluded education organizations are dropped from the ODS side', () => {
    const result = compareRows([org('a'), org('t', { educationOrganizationId: 5 })], [org('a')], { excluded: ['5'] });
    expect(result.excludedRows).toBe(1);
    expect(unexplainedCount(result)).toBe(0);
  });
});

describe('compareValues', () => {
  test('a number and a string with the same digits differ', () => {
    expect(compareValues(1, '1')).toBe('value');
    expect(compareValues([1, 2], [2, 1])).toBe('order');
    expect(compareValues({ b: 1, a: 2 }, { a: 2, b: 1 })).toBeNull();
  });
});
