// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import { normalizeValue, normalizeRow, compareEngines } from '../compare-dms-engines.js';
import { unexplainedCount } from '../compare-dms-database.js';

const COLUMNS = ['sourcedId', 'dateLastModified', 'participantDocumentId', 'startDate', 'orgs', 'schoolYear'];

describe('normalizeValue', () => {
  test('gives both drivers the same shapes', () => {
    expect(normalizeValue(2026)).toBe('2026');
    expect(normalizeValue('2026')).toBe('2026');
    expect(normalizeValue(true)).toBe('true');
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(new Date('2026-08-15T00:00:00Z'), true)).toBe('2026-08-15');
    expect(normalizeValue(new Date('2026-08-15T10:30:00Z'))).toBe('2026-08-15T10:30:00.000Z');
  });

  test('parses JSON text and leaves other text alone', () => {
    expect(normalizeValue('[{"sourcedId":"a"}]')).toEqual([{ sourcedId: 'a' }]);
    expect(normalizeValue('[not json]')).toBe('[not json]');
    expect(normalizeValue('Grand Bend')).toBe('Grand Bend');
  });
});

describe('compareEngines', () => {
  // A SQL Server row and a PostgreSQL row for the same session, as each driver returns it
  const pgSide = () => ({
    columns: COLUMNS,
    rows: [normalizeRow({
      sourcedId: 'a', dateLastModified: new Date('2026-10-01T00:00:00Z'), participantDocumentId: '11',
      startDate: '2026-08-15', orgs: [{ sourcedId: 'o1' }, { sourcedId: 'o2' }], schoolYear: '2026'
    })]
  });
  const mssqlSide = (overrides = {}) => ({
    columns: COLUMNS,
    rows: [normalizeRow({
      sourcedId: 'a', dateLastModified: new Date('2026-10-02T00:00:00Z'), participantDocumentId: '99',
      startDate: new Date('2026-08-15T00:00:00Z'), orgs: '[{"sourcedId":"o1"},{"sourcedId":"o2"}]', schoolYear: 2026, ...overrides
    }, new Set(['startDate']))]
  });

  test('the same data reads as identical, ignoring load times and DocumentIds', () => {
    const result = compareEngines(pgSide(), mssqlSide());
    expect(result.identical).toBe(1);
    expect(unexplainedCount(result)).toBe(0);
  });

  test('a different value fails, an order-only difference does not', () => {
    expect(unexplainedCount(compareEngines(pgSide(), mssqlSide({ schoolYear: 2025 })))).toBe(1);
    const reordered = compareEngines(pgSide(), mssqlSide({ orgs: '[{"sourcedId":"o2"},{"sourcedId":"o1"}]' }));
    expect(reordered.orderOnly).toEqual({ orgs: 1 });
    expect(unexplainedCount(reordered)).toBe(0);
  });

  test('every column must exist on both engines, the person keys and dateLastModified included', () => {
    const missing = { ...mssqlSide(), columns: COLUMNS.filter(c => c !== 'participantDocumentId' && c !== 'dateLastModified') };
    const result = compareEngines(pgSide(), missing);
    expect(result.columnsOnlyOds).toEqual(['dateLastModified', 'participantDocumentId']);
    expect(unexplainedCount(result)).toBe(2);
  });
});
