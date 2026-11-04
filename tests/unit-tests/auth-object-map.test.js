// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect } from '@jest/globals';
import knex from 'knex';
import AuthorizationQueryService from '../../src/services/database/AuthorizationQueryService.js';
import {
  ODS_AUTH_OBJECT_MAP,
  DMS_AUTH_OBJECT_MAP,
  getAuthObjectMap
} from '../../src/platform/auth-object-map.js';

// Real query builders without connections: queries are compiled, never run
const pg = knex({ client: 'pg' });
const mssql = knex({ client: 'mssql' });

const squash = sql => sql.replace(/\s+/g, ' ').trim();

/**
 * Run getOrgCoverage against a stand-in knex that compiles the raw statement with the given
 * dialect and answers with a full-coverage row.
 */
async function compileCoverageQuery(dialect, authObjects) {
  let compiled = null;
  const knexInstance = {
    raw: jest.fn((sql, bindings) => {
      compiled = squash(dialect.raw(sql, bindings).toQuery());
      return Promise.resolve({ rows: [{ servedorgs: '4', unreachableorgs: '0' }] });
    })
  };
  const service = new AuthorizationQueryService(knexInstance, 'oneroster12', 'auth', authObjects);

  const coverage = await service.getOrgCoverage(['255901']);

  return { compiled, coverage, bindings: knexInstance.raw.mock.calls[0][1] };
}

async function compileFilter(authObjects, endpoint, table) {
  const service = new AuthorizationQueryService(pg, 'oneroster12', 'auth', authObjects);
  // Skip the full-access probe, which would need a database
  service.hasFullEducationOrganizationAccess = async () => false;

  const filter = await service.getAuthorizationFilter(endpoint, ['255901']);
  const query = service.applyAuthorizationFilter(pg.withSchema('oneroster12').from(table).select('sourcedId'), filter);

  return query.toSQL().sql;
}

describe('auth object maps', () => {
  test('getAuthObjectMap selects by platform', () => {
    expect(getAuthObjectMap('ods')).toBe(ODS_AUTH_OBJECT_MAP);
    expect(getAuthObjectMap('dms')).toBe(DMS_AUTH_OBJECT_MAP);
  });

  test('AuthorizationQueryService defaults to the ODS/API map', () => {
    expect(new AuthorizationQueryService(pg).authObjects).toBe(ODS_AUTH_OBJECT_MAP);
  });

  describe('coverage query', () => {
    test('is unchanged on the ODS/API: lower-case auth names written inline', async () => {
      const { compiled, coverage, bindings } = await compileCoverageQuery(pg, ODS_AUTH_OBJECT_MAP);

      expect(bindings).toEqual(['255901', 'educationOrganizationId']);
      expect(compiled).toContain('from auth.educationorganizationidtoeducationorganizationid auth_map');
      expect(compiled).toContain("where auth_map.sourceeducationorganizationid in ('255901')");
      expect(compiled).toContain('and auth_map.targeteducationorganizationid = served."educationOrganizationId"');
      expect(coverage).toEqual({ servedOrgs: 4, unreachableOrgs: 0 });
    });

    test('quotes the DMS auth names on PostgreSQL', async () => {
      const { compiled } = await compileCoverageQuery(pg, DMS_AUTH_OBJECT_MAP);

      expect(compiled).toContain('(select count(*) from oneroster12.orgs) as servedorgs');
      expect(compiled).toContain('from "auth"."EducationOrganizationIdToEducationOrganizationId" auth_map');
      expect(compiled).toContain('where auth_map."SourceEducationOrganizationId" in (\'255901\')');
      expect(compiled).toContain('and auth_map."TargetEducationOrganizationId" = served."educationOrganizationId"');
    });

    test('counts an ed-org named in the claim as reachable on DMS', async () => {
      const { compiled, bindings } = await compileCoverageQuery(pg, DMS_AUTH_OBJECT_MAP);

      expect(compiled).toMatch(/\) and served\."educationOrganizationId" not in \('255901'\)\) as unreachableorgs$/);
      expect(bindings.slice(-2)).toEqual(['educationOrganizationId', '255901']);
    });

    test('brackets the DMS auth names on SQL Server', async () => {
      const { compiled } = await compileCoverageQuery(mssql, DMS_AUTH_OBJECT_MAP);

      expect(compiled).toContain('from [auth].[EducationOrganizationIdToEducationOrganizationId] auth_map');
      expect(compiled).toMatch(/where auth_map\.\[SourceEducationOrganizationId\] in \(N?'255901'\)/);
      expect(compiled).toContain('and auth_map.[TargetEducationOrganizationId] = served.[educationOrganizationId]');
    });
  });

  describe('relationship filters', () => {
    test('read the ODS/API hierarchy and USI views', async () => {
      const sql = await compileFilter(ODS_AUTH_OBJECT_MAP, 'enrollments', 'enrollments');

      expect(sql).toContain('"enrollments"."educationOrganizationId" in (select "targeteducationorganizationid" from "auth"."educationorganizationidtoeducationorganizationid" where "sourceeducationorganizationid" in (?))');
      expect(sql).toContain('"enrollments"."participantUSI" in (select "studentusi" from "auth"."educationorganizationidtostudentusi" where "sourceeducationorganizationid" in (?))');
      expect(sql).toContain('"enrollments"."participantUSI" in (select "staffusi" from "auth"."educationorganizationidtostaffusi" where "sourceeducationorganizationid" in (?))');
    });

    test('read the DMS hierarchy and DocumentId views for users, students, staff and contacts', async () => {
      const sql = await compileFilter(DMS_AUTH_OBJECT_MAP, 'users', 'users');

      expect(sql).toContain('"users"."educationOrganizationId" in (select "TargetEducationOrganizationId" from "auth"."EducationOrganizationIdToEducationOrganizationId" where "SourceEducationOrganizationId" in (?) union select cast(? as bigint))');
      expect(sql).toContain('"users"."participantDocumentId" in (select "Student_DocumentId" from "auth"."EducationOrganizationIdToStudentDocumentId" where "SourceEducationOrganizationId" in (?))');
      expect(sql).toContain('"users"."participantDocumentId" in (select "Contact_DocumentId" from "auth"."EducationOrganizationIdToContactDocumentId" where "SourceEducationOrganizationId" in (?))');
      expect(sql).toContain('"users"."participantDocumentId" in (select "Staff_DocumentId" from "auth"."EducationOrganizationIdToStaffDocumentId" where "SourceEducationOrganizationId" in (?))');
      expect(sql).not.toMatch(/usi/i);
    });

    test('add the claimed ed-orgs to the reachable set on DMS only', async () => {
      const dms = new AuthorizationQueryService(pg, 'oneroster12', 'auth', DMS_AUTH_OBJECT_MAP).buildAccessibleOrgIdsQuery(['255901', '255902']).toSQL();
      const ods = new AuthorizationQueryService(pg, 'oneroster12', 'auth', ODS_AUTH_OBJECT_MAP).buildAccessibleOrgIdsQuery(['255901']).toSQL();

      expect(dms.sql).toBe('select "TargetEducationOrganizationId" from "auth"."EducationOrganizationIdToEducationOrganizationId" where "SourceEducationOrganizationId" in (?, ?) union select cast(? as bigint) union all select cast(? as bigint)');
      expect(dms.bindings).toEqual(['255901', '255902', '255901', '255902']);
      expect(ods.sql).not.toContain('union');
    });

    test('read the DMS student view for demographics', async () => {
      const sql = await compileFilter(DMS_AUTH_OBJECT_MAP, 'demographics', 'demographics');

      expect(sql).toContain('"demographics"."studentDocumentId" in (select "Student_DocumentId" from "auth"."EducationOrganizationIdToStudentDocumentId"');
    });

    test('read the DMS hierarchy upwards for courses', async () => {
      const sql = await compileFilter(DMS_AUTH_OBJECT_MAP, 'courses', 'courses');

      expect(sql).toContain('"courses"."educationOrganizationId" in (select "SourceEducationOrganizationId" from "auth"."EducationOrganizationIdToEducationOrganizationId" where "TargetEducationOrganizationId" in (?))');
    });

    test('use the only DMS contact mapping without probing the database', async () => {
      const hasTable = jest.fn();
      const knexInstance = { schema: { withSchema: jest.fn(() => ({ hasTable })) } };
      const service = new AuthorizationQueryService(knexInstance, 'oneroster12', 'auth', DMS_AUTH_OBJECT_MAP);

      await expect(service.resolveParentAuthMapping()).resolves.toEqual({
        tableName: 'EducationOrganizationIdToContactDocumentId',
        personColumn: 'Contact_DocumentId'
      });
      expect(hasTable).not.toHaveBeenCalled();
    });
  });
});
