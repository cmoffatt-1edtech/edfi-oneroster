// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import {
  EXPECTATIONS, EXPECTED_COUNTS, FIXTURE, fixtureDescriptors, md5, parseDescriptorUri, toDmsRows, toOdsRows
} from '../dms-parity-fixture.js';

const counter = () => {
  let next = 1;
  return () => next++;
};
const ods = toOdsRows(FIXTURE, counter());
const dms = toDmsRows(FIXTURE, counter());
const STUDENT_IDENTIFICATION_CODES = '{{table:Ed-Fi/StudentEducationOrganizationAssociation/$.studentIdentificationCodes[*]}}';
const EDORG_TABLES = ['edfi.StateEducationAgency', 'edfi.LocalEducationAgency', 'edfi.School'];

const countByTable = rows => rows.reduce((counts, row) => ({ ...counts, [row.table]: (counts[row.table] || 0) + 1 }), {});
const documentIds = table => new Set(dms.filter(row => row.table === table).map(row => row.values.DocumentId));

describe('dms-parity-fixture writers', () => {
  test('write the same rows to each platform, table for table', () => {
    const odsCounts = countByTable(ods);
    const dmsCounts = countByTable(dms);
    for (const [table, count] of Object.entries(dmsCounts)) {
      const odsTable = table === STUDENT_IDENTIFICATION_CODES
        ? 'edfi.studenteducationorganizationassociationstudentidentifica_c15030'
        : table.toLowerCase();
      expect([table, odsCounts[odsTable]]).toEqual([table, count]);
    }
    // the ODS also writes the education organization base table
    const edorgs = FIXTURE.stateEducationAgencies.length + FIXTURE.localEducationAgencies.length + FIXTURE.schools.length;
    expect(odsCounts['edfi.educationorganization']).toBe(edorgs);
    expect(Object.keys(odsCounts)).toHaveLength(Object.keys(dmsCounts).length + 1);
  });

  test('every DMS reference to a fixture document names a row of the referenced resource', () => {
    const targets = {
      Student: ['edfi.Student'], Staff: ['edfi.Staff'], Contact: ['edfi.Contact'], Section: ['edfi.Section'],
      CourseOffering: ['edfi.CourseOffering'], Course: ['edfi.Course'], Session: ['edfi.Session'], School: ['edfi.School'],
      LocationSchool: ['edfi.School'], LocalEducationAgency: ['edfi.LocalEducationAgency'],
      StateEducationAgency: ['edfi.StateEducationAgency'], EducationOrganization: EDORG_TABLES,
      StudentEducationOrganizationAssociation: ['edfi.StudentEducationOrganizationAssociation'], CalendarDate: ['edfi.CalendarDate']
    };
    // referenced documents the projections don't read: an id, no row, and no clash with a row
    const rowless = new Set(['SchoolYear', 'Calendar', 'ClassPeriod', 'LocationLocation']);
    const allRows = new Set(dms.map(row => row.values.DocumentId).filter(id => id !== undefined));
    let checked = 0;
    for (const { table, values } of dms) {
      for (const [column, value] of Object.entries(values)) {
        const match = /^(.+)_DocumentId$/.exec(column);
        if (!match || value === null) continue;
        checked++;
        if (rowless.has(match[1])) {
          expect([table, column, allRows.has(value)]).toEqual([table, column, false]);
          continue;
        }
        expect(targets[match[1]]).toBeDefined();
        const found = targets[match[1]].some(target => documentIds(target).has(value));
        expect([table, column, found]).toEqual([table, column, true]);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test('DocumentIds are unique', () => {
    const ids = dms.map(row => row.values.DocumentId).filter(id => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('staff school associations are created in the same order on both platforms', () => {
    const odsOrder = ods.filter(row => row.table === 'edfi.staffschoolassociation')
      .sort((a, b) => a.values.createdate.localeCompare(b.values.createdate))
      .map(row => row.values.schoolid);
    const dmsOrder = dms.filter(row => row.table === 'edfi.StaffSchoolAssociation')
      .sort((a, b) => a.values.DocumentId - b.values.DocumentId)
      .map(row => row.values.SchoolId_Unified);
    expect(dmsOrder).toEqual(odsOrder);
    expect(odsOrder).toEqual(FIXTURE.staffSchoolAssociations.map(ssa => ssa.school));
  });

  test('every descriptor the writers use is listed for resolution', () => {
    const listed = new Set(fixtureDescriptors());
    const used = [...ods, ...dms].flatMap(row => Object.values(row.values))
      .filter(value => value && typeof value === 'object' && '$descriptor' in value)
      .map(value => value.$descriptor);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter(uri => !listed.has(uri))).toEqual([]);
  });

  test('parseDescriptorUri splits namespace, code value and type', () => {
    expect(parseDescriptorUri('uri://ed-fi.org/RaceDescriptor#Black or African American')).toEqual({
      namespace: 'uri://ed-fi.org/RaceDescriptor', codeValue: 'Black or African American', type: 'RaceDescriptor'
    });
  });
});

describe('dms-parity-fixture expectations', () => {
  test('name known views and distinct rows', () => {
    const ids = EXPECTATIONS.map(e => `${e.view}:${e.id ?? md5(e.key)}`);
    expect(new Set(ids).size).toBe(ids.length);
    for (const expectation of EXPECTATIONS) {
      expect(Object.keys(EXPECTED_COUNTS)).toContain(expectation.view);
      expect(Boolean(expectation.absent) !== Boolean(expectation.values)).toBe(true);
    }
  });

  test('cover every projection', () => {
    expect(new Set(EXPECTATIONS.map(e => e.view))).toEqual(new Set(Object.keys(EXPECTED_COUNTS)));
  });
});
