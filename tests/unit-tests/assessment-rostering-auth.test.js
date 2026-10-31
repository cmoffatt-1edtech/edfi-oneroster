// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import knex from 'knex';
import AuthorizationQueryService, { AUTH_ENDPOINTS } from '../../src/services/database/AuthorizationQueryService.js';
import { ODS_AUTH_OBJECT_MAP, DMS_AUTH_OBJECT_MAP } from '../../src/platform/auth-object-map.js';
import { ASSESSMENT_ENDPOINTS } from '../../src/config/assessment-rostering.js';

// The assessment rostering authorization filters (docs/design/assessment-rostering-mappings.md, Authorization), compiled
// with real query builders and no connection.
const pg = knex({ client: 'pg' });
const mssql = knex({ client: 'mssql' });

async function compile(dialect, authObjects, endpoint, { fullAccess = false } = {}) {
  const service = new AuthorizationQueryService(dialect, 'oneroster12', 'auth', authObjects);
  // Skip the coverage probe, which needs a database
  service.hasFullEducationOrganizationAccess = async () => fullAccess;

  const filter = await service.getAuthorizationFilter(endpoint, ['255901001']);
  const query = service.applyAuthorizationFilter(dialect.withSchema('oneroster12').from(endpoint).select('sourcedId'), filter);
  return { filter, sql: query.toString() };
}

// Down(C) and Up(C) on the ODS hierarchy, as PostgreSQL compiles them
const ODS_DOWN = 'select "targeteducationorganizationid" from "auth"."educationorganizationidtoeducationorganizationid" where "sourceeducationorganizationid" in (\'255901001\')';
const ODS_UP = 'select "sourceeducationorganizationid" from "auth"."educationorganizationidtoeducationorganizationid" where "targeteducationorganizationid" in (\'255901001\')';
const DMS_DOWN = 'select "TargetEducationOrganizationId" from "auth"."EducationOrganizationIdToEducationOrganizationId" where "SourceEducationOrganizationId" in (\'255901001\') union select cast(\'255901001\' as bigint)';
const DMS_UP = 'select "SourceEducationOrganizationId" from "auth"."EducationOrganizationIdToEducationOrganizationId" where "TargetEducationOrganizationId" in (\'255901001\')';

describe('assessment rostering authorization', () => {
  test('the three endpoints have filters, so the full-access short circuit covers them', () => {
    expect(AUTH_ENDPOINTS).toMatchObject(ASSESSMENT_ENDPOINTS);
  });

  test.each(Object.values(ASSESSMENT_ENDPOINTS))('%s skips filtering for a caller who reaches every organization', async endpoint => {
    const { filter, sql } = await compile(pg, ODS_AUTH_OBJECT_MAP, endpoint, { fullAccess: true });

    expect(filter.fullAccess).toBe(true);
    expect(sql).toBe(`select "sourcedId" from "oneroster12"."${endpoint}"`);
  });

  describe('assessmentEnrollments: registration school down the hierarchy and the student mapping', () => {
    test('ODS', async () => {
      const { sql } = await compile(pg, ODS_AUTH_OBJECT_MAP, 'assessmentenrollments');

      expect(sql).toBe('select "sourcedId" from "oneroster12"."assessmentenrollments"'
        + ` where "assessmentenrollments"."educationOrganizationId" in (${ODS_DOWN})`
        + ' and "assessmentenrollments"."participantUSI" in (select "studentusi" from "auth"."educationorganizationidtostudentusi" where "sourceeducationorganizationid" in (\'255901001\'))');
    });

    test('DMS', async () => {
      const { sql } = await compile(pg, DMS_AUTH_OBJECT_MAP, 'assessmentenrollments');

      expect(sql).toBe('select "sourcedId" from "oneroster12"."assessmentenrollments"'
        + ` where "assessmentenrollments"."educationOrganizationId" in (${DMS_DOWN})`
        + ' and "assessmentenrollments"."participantDocumentId" in (select "Student_DocumentId" from "auth"."EducationOrganizationIdToStudentDocumentId" where "SourceEducationOrganizationId" in (\'255901001\'))');
    });

    test('never looks above the caller, so a testing or reporting organization cannot widen access', async () => {
      const { sql } = await compile(pg, ODS_AUTH_OBJECT_MAP, 'assessmentenrollments');

      expect(sql).not.toContain('"targeteducationorganizationid" in (');
      expect(sql).not.toContain('assessmentauthorgs');
    });
  });

  describe('assessmentOfferings: any organization of the offering above or below the caller', () => {
    test('ODS', async () => {
      const { sql } = await compile(pg, ODS_AUTH_OBJECT_MAP, 'assessmentofferings');

      expect(sql).toBe('select "sourcedId" from "oneroster12"."assessmentofferings"'
        + ' where "assessmentofferings"."sourcedId" in (select "assessmentOfferingSourcedId" from "oneroster12"."assessmentauthorgs"'
        + ` where "assessmentOfferingSourcedId" is not null and "educationOrganizationId" in (${ODS_DOWN} union ${ODS_UP}))`);
    });

    test('DMS', async () => {
      const { sql } = await compile(pg, DMS_AUTH_OBJECT_MAP, 'assessmentofferings');

      expect(sql).toContain(`"educationOrganizationId" in (${DMS_DOWN} union ${DMS_UP})`);
    });
  });

  describe('assessments: no defining organization, or any organization in reach', () => {
    test('ODS', async () => {
      const { sql } = await compile(pg, ODS_AUTH_OBJECT_MAP, 'assessments');

      expect(sql).toBe('select "sourcedId" from "oneroster12"."assessments"'
        + ' where ("assessments"."definingEducationOrganizationId" is null'
        + ' or "assessments"."sourcedId" in (select "assessmentSourcedId" from "oneroster12"."assessmentauthorgs"'
        + ` where "assessmentSourcedId" is not null and "educationOrganizationId" in (${ODS_DOWN} union ${ODS_UP})))`);
    });

    test('DMS', async () => {
      const { sql } = await compile(pg, DMS_AUTH_OBJECT_MAP, 'assessments');

      expect(sql).toContain('("assessments"."definingEducationOrganizationId" is null or');
      expect(sql).toContain(`"educationOrganizationId" in (${DMS_DOWN} union ${DMS_UP})`);
    });
  });

  test.each([
    ['ODS', ODS_AUTH_OBJECT_MAP, '[auth].[educationorganizationidtoeducationorganizationid]'],
    ['DMS', DMS_AUTH_OBJECT_MAP, '[auth].[EducationOrganizationIdToEducationOrganizationId]']
  ])('SQL Server: %s names compile the same filters', async (platform, authObjects, hierarchy) => {
    for (const endpoint of Object.values(ASSESSMENT_ENDPOINTS)) {
      const { sql } = await compile(mssql, authObjects, endpoint);
      expect(sql).toContain(`from [oneroster12].[${endpoint}] where`);
      expect(sql).toContain(hierarchy);
    }
    const { sql } = await compile(mssql, authObjects, 'assessmentofferings');
    expect(sql).toContain('from [oneroster12].[assessmentauthorgs] where [assessmentOfferingSourcedId] is not null');
  });

  test('courses and academic sessions still look up the hierarchy the same way', async () => {
    const service = new AuthorizationQueryService(pg, 'oneroster12', 'auth', ODS_AUTH_OBJECT_MAP);

    expect(service.buildAncestorOrgIdsQuery(['255901001']).toString()).toBe(ODS_UP);

    service.hasFullEducationOrganizationAccess = async () => false;
    const courses = await service.getAuthorizationFilter('courses', ['255901001']);
    const sql = courses.apply(pg.from('courses').select('sourcedId')).toString();
    expect(sql).toContain(`or "courses"."educationOrganizationId" in (${ODS_UP})`);
  });
});
