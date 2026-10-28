// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { getLogger } from '../../utils/logger.js';
import { ODS_AUTH_OBJECT_MAP } from '../../platform/auth-object-map.js';

/**
 * Authorization Query Service
 * Handles education organization-based filtering using Ed-Fi auth views. The auth object and
 * person-key column names come from the platform's auth object map (src/platform/auth-object-map.js).
 */

const logger = getLogger('AuthorizationQueryService');

// Endpoints with a purpose-built authorization filter
const AUTH_ENDPOINTS = {
  orgs: 'orgs',
  users: 'users',
  classes: 'classes',
  courses: 'courses',
  enrollments: 'enrollments',
  demographics: 'demographics',
  academicSessions: 'academicsessions'
};

// Membership set for the full-access short circuit, so an unrecognised endpoint can never
// take the unfiltered path. Derived from the map above so the two cannot drift apart.
const AUTH_ENDPOINT_NAMES = new Set(Object.values(AUTH_ENDPOINTS));

// The organizations this API serves. Every educationOrganizationId carried by a OneRoster
// resource is one of these, so it is the set the relationship filter can discriminate on.
const ORGS_TABLE = 'orgs';
const ORGS_ORG_ID_COLUMN = 'educationOrganizationId';

class AuthorizationQueryService {
  constructor(knexInstance, schema = 'oneroster12', authSchema = 'auth', authObjects = ODS_AUTH_OBJECT_MAP) {
    this.knex = knexInstance;
    this.schema = schema;
    this.authSchema = authSchema;
    this.authObjects = authObjects;
    this.parentAuthMapping = null;
  }

  /**
   * An auth object name for hand-written SQL. Lower-case names are written as they are, which
   * resolves on both engines; mixed-case names are bound as identifiers so they are quoted.
   * @returns {{ sql: string, bindings: string[] }}
   */
  rawIdentifier(name) {
    return this.authObjects.caseSensitiveNames
      ? { sql: '??', bindings: [name] }
      : { sql: name, bindings: [] };
  }

  /**
   * Determine whether the caller reaches every education organization in the ODS.
   *
   * When they do, the relationship filter excludes nothing, so evaluating it per row is
   * pure overhead: the auth mappings are correlated subqueries the optimizer cannot estimate
   * through, which forces a nested loop over the whole table.
   *
   * Any error, or an inability to determine coverage, leaves normal filtering in place.
   *
   * @param {Array<string|number>} educationOrganizationIds - Source education organization IDs
   * @returns {Promise<boolean>} True when the caller's reach covers the whole hierarchy
   */
  async hasFullEducationOrganizationAccess(educationOrganizationIds) {
    // No claims means no access, and an empty list would make the coverage query invalid
    if (!educationOrganizationIds || educationOrganizationIds.length === 0) {
      return false;
    }

    const coverage = await this.getOrgCoverage(educationOrganizationIds);

    if (coverage === null) {
      return false;
    }

    // An ODS with no organizations at all must not be read as universal access
    return coverage.servedOrgs > 0 && coverage.unreachableOrgs === 0;
  }

  /**
   * Count the organizations this API serves, and how many of those the caller cannot reach.
   *
   * Measured against the served organizations rather than the auth mapping, so an incomplete
   * mapping cannot read as full coverage and grant unfiltered access.
   *
   * Counted rather than tested for existence. An existence test gives the optimizer a row
   * goal of one, which it satisfies by seeking the auth mapping once per organization;
   * counting lets it read the caller's range of the mapping once and hash join against it,
   * which measures around two orders of magnitude cheaper on a state sized hierarchy.
   *
   * Both figures come from one statement so they describe the same snapshot.
   *
   * @param {Array<string|number>} educationOrganizationIds - Source education organization IDs
   * @returns {Promise<Object|null>} { servedOrgs, unreachableOrgs }, or null if undetermined
   */
  async getOrgCoverage(educationOrganizationIds) {
    // Schema and table names are internal constants and the caller's IDs are bound. The
    // column is bound as an identifier because PostgreSQL defines it as quoted camel case.
    // Auth object names are bound the same way when the platform's are mixed case.
    const idPlaceholders = educationOrganizationIds.map(() => '?').join(', ');
    const authTable = this.rawIdentifier(`${this.authSchema}.${this.authObjects.tables.orgToOrg}`);
    const sourceColumn = this.rawIdentifier(this.authObjects.columns.sourceOrgId);
    const targetColumn = this.rawIdentifier(this.authObjects.columns.targetOrgId);

    const sql = `select
        (select count(*) from ${this.schema}.${ORGS_TABLE}) as servedorgs,
        (select count(*)
           from ${this.schema}.${ORGS_TABLE} served
          where not exists (
                select 1
                  from ${authTable.sql} auth_map
                 where auth_map.${sourceColumn.sql} in (${idPlaceholders})
                   and auth_map.${targetColumn.sql} = served.??
              )) as unreachableorgs`;

    // In the order the placeholders appear
    const bindings = [
      ...authTable.bindings,
      ...sourceColumn.bindings,
      ...educationOrganizationIds,
      ...targetColumn.bindings,
      ORGS_ORG_ID_COLUMN
    ];

    try {
      const result = await this.knex.raw(sql, bindings);

      // PostgreSQL returns { rows }, MSSQL returns the array directly
      const rows = result?.rows || result;

      if (!Array.isArray(rows) || rows.length === 0) {
        return null;
      }

      // PostgreSQL returns counts as strings, MSSQL as numbers
      const servedOrgs = Number(rows[0]?.servedorgs);
      const unreachableOrgs = Number(rows[0]?.unreachableorgs);

      if (!Number.isFinite(servedOrgs) || !Number.isFinite(unreachableOrgs)) {
        return null;
      }

      return { servedOrgs, unreachableOrgs };
    } catch (error) {
      logger.warn(
        `Unable to determine education organization coverage: ${error.message}`
      );
      return null;
    }
  }

  async resolveParentAuthMapping() {
    const candidates = this.authObjects.contactMappings;
    const defaultMapping = candidates[0];

    if (this.parentAuthMapping) {
      return this.parentAuthMapping;
    }

    // A single candidate (DMS) needs no probe
    if (candidates.length === 1 || !this.knex?.schema || typeof this.knex.schema.withSchema !== 'function') {
      this.parentAuthMapping = defaultMapping;
      return this.parentAuthMapping;
    }

    for (const candidate of candidates) {
      try {
        const exists = await this.knex.schema.withSchema(this.authSchema).hasTable(candidate.tableName);
        if (exists) {
          this.parentAuthMapping = candidate;
          return this.parentAuthMapping;
        }
      } catch (error) {
        logger.warn(
          `Unable to check auth view ${candidate.tableName}: ${error.message}`
        );
      }
    }

    this.parentAuthMapping = defaultMapping;

    return this.parentAuthMapping;
  }

  /**
  * Build a subquery for accessible education organization IDs
  * @param {Array<string>} educationOrganizationIds - Source education organization IDs
  * @returns {Object|null} Knex subquery selecting accessible org IDs, or null if input is empty
   */
  buildAccessibleOrgIdsQuery(educationOrganizationIds) {
    if (!educationOrganizationIds || educationOrganizationIds.length === 0) {
      return null;
    }

    return this.knex
      .withSchema(this.authSchema)
      .select(this.authObjects.columns.targetOrgId)
      .from(this.authObjects.tables.orgToOrg)
      .whereIn(this.authObjects.columns.sourceOrgId, educationOrganizationIds);
  }

  /**
   * Build authorization filter for organizations
   * Returns SQL WHERE clause to filter orgs table
   */
  async buildOrgAuthorizationFilter(educationOrganizationIds) {
    const accessibleOrgIds = this.buildAccessibleOrgIdsQuery(educationOrganizationIds);

    if (!accessibleOrgIds) {
      return null;
    }

    return { field: 'educationOrganizationId', values: accessibleOrgIds };
  }

  /**
   * Build authorization filter for users (students/teachers)
   * Returns SQL WHERE clause to filter users table
   */
  async buildUserAuthorizationFilter(educationOrganizationIds) {
    const accessibleOrgIds = this.buildAccessibleOrgIdsQuery(educationOrganizationIds);
    const parentAuthMapping = await this.resolveParentAuthMapping();

    if (!accessibleOrgIds) {
      return null;
    }

    const studentAuthQuery = () =>
      this.knex
        .withSchema(this.authSchema)
        .select(this.authObjects.columns.student)
        .from(this.authObjects.tables.orgToStudent)
        .whereIn(this.authObjects.columns.sourceOrgId, educationOrganizationIds);

    const staffAuthQuery = () =>
      this.knex
        .withSchema(this.authSchema)
        .select(this.authObjects.columns.staff)
        .from(this.authObjects.tables.orgToStaff)
        .whereIn(this.authObjects.columns.sourceOrgId, educationOrganizationIds);

    const contactAuthQuery = () =>
      this.knex
        .withSchema(this.authSchema)
        .select(parentAuthMapping.personColumn)
        .from(parentAuthMapping.tableName)
        .whereIn(this.authObjects.columns.sourceOrgId, educationOrganizationIds);


    return {
      apply: query =>
        query.whereIn('users.educationOrganizationId', accessibleOrgIds)
        .where(builder => {
            builder.orWhere(studentFilter => {
              studentFilter
                .where('users.role', 'student')
                .whereIn(`users.${this.authObjects.projectionColumns.participant}`, studentAuthQuery());
            });

            builder.orWhere(parentFilter => {
              parentFilter
                .where('users.role', 'parent')
                .whereIn(`users.${this.authObjects.projectionColumns.participant}`, contactAuthQuery());
            });

            builder.orWhere(staffFilter => {
              staffFilter
                .whereNotIn('users.role', ['student', 'parent'])
                .whereIn(`users.${this.authObjects.projectionColumns.participant}`, staffAuthQuery());
            });
        })
    };
  }

  /**
   * Build authorization filter for classes
   * Returns SQL WHERE clause to filter classes table
   */
  async buildClassAuthorizationFilter(educationOrganizationIds) {
    const accessibleOrgIds = this.buildAccessibleOrgIdsQuery(educationOrganizationIds);

    if (!accessibleOrgIds) {
      return null;
    }

    return { field: 'educationOrganizationId', values: accessibleOrgIds };
  }

  /**
   * Build authorization filter for courses
   * Returns SQL WHERE clause to filter courses table
   */
  async buildCourseAuthorizationFilter(educationOrganizationIds) {
    const accessibleOrgIds = this.buildAccessibleOrgIdsQuery(educationOrganizationIds);

    if (!accessibleOrgIds) {
      return null;
    }

    /**
    * Uses the RelationshipsWithEdOrgsOnlyInverted authorization strategy to enable
    * reference data access up the education organization hierarchy. The parent
    * EducationOrganizationId is derived from the authorized EducationOrganizationId,
    * allowing schools to read district-level course records while preventing access
    * to data owned by other schools or districts.
    */
    const courseSourceOrgQuery = () =>
      this.knex
        .withSchema(this.authSchema)
        .select(this.authObjects.columns.sourceOrgId)
        .from(this.authObjects.tables.orgToOrg)
        .whereIn(this.authObjects.columns.targetOrgId, educationOrganizationIds);

    return {
      apply: query =>
        query.where(builder => {
          builder
            .whereIn('courses.educationOrganizationId', accessibleOrgIds)
            .orWhereIn('courses.educationOrganizationId', courseSourceOrgQuery());
        })
    };
  }

  /**
   * Build authorization filter for enrollments
   * Returns SQL WHERE clause to filter enrollments table
   */
  async buildEnrollmentAuthorizationFilter(educationOrganizationIds) {
    const accessibleOrgIds = this.buildAccessibleOrgIdsQuery(educationOrganizationIds);

    if (!accessibleOrgIds) {
      return null;
    }

    const studentAuthQuery = () =>
      this.knex
        .withSchema(this.authSchema)
        .select(this.authObjects.columns.student)
        .from(this.authObjects.tables.orgToStudent)
        .whereIn(this.authObjects.columns.sourceOrgId, educationOrganizationIds);

    const staffAuthQuery = () =>
      this.knex
        .withSchema(this.authSchema)
        .select(this.authObjects.columns.staff)
        .from(this.authObjects.tables.orgToStaff)
        .whereIn(this.authObjects.columns.sourceOrgId, educationOrganizationIds);

    return {
      apply: query =>
        query
          .whereIn('enrollments.educationOrganizationId', accessibleOrgIds)
          .where(builder => {
            builder
              .where(studentFilter => {
                studentFilter
                  .where('enrollments.role', 'student')
                  .whereIn(`enrollments.${this.authObjects.projectionColumns.participant}`, studentAuthQuery());
              })
              .orWhere(staffFilter => {
                staffFilter
                  .where('enrollments.role', 'teacher')
                  .whereIn(`enrollments.${this.authObjects.projectionColumns.participant}`, staffAuthQuery());
              });
          })
    };
  }

  /**
   * Build authorization filter for demographics
   * Returns SQL WHERE clause to filter demographics table
   */
  async buildDemographicsAuthorizationFilter(educationOrganizationIds) {
    const accessibleOrgIds = this.buildAccessibleOrgIdsQuery(educationOrganizationIds);

    if (!accessibleOrgIds) {
      return null;
    }

    const studentAuthQuery = () =>
      this.knex
        .withSchema(this.authSchema)
        .select(this.authObjects.columns.student)
        .from(this.authObjects.tables.orgToStudent)
        .whereIn(this.authObjects.columns.sourceOrgId, educationOrganizationIds);

     return {
      apply: query =>
        query
          .whereIn('demographics.educationOrganizationId', accessibleOrgIds)
          .where(builder => {
            builder
              .where(studentFilter => {
                studentFilter
                  .whereIn(`demographics.${this.authObjects.projectionColumns.student}`, studentAuthQuery());
              })
          })
    };
  }

  /**
   * Build authorization filter for academic sessions
   * Returns SQL WHERE clause to filter academicsessions table
   */
  async buildAcademicSessionAuthorizationFilter(educationOrganizationIds) {
    const accessibleOrgIds = this.buildAccessibleOrgIdsQuery(educationOrganizationIds);

    if (!accessibleOrgIds) {
      return null;
    }

    /**
    * Uses the RelationshipsWithEdOrgsOnlyInverted authorization strategy for schoolYear.
    * The parent EducationOrganizationId is derived from the authorized
    * EducationOrganizationId so schools can read district-level school year records
    */
    const schoolYearSourceOrgQuery = () =>
      this.knex
        .withSchema(this.authSchema)
        .select(this.authObjects.columns.sourceOrgId)
        .from(this.authObjects.tables.orgToOrg)
        .whereIn(this.authObjects.columns.targetOrgId, educationOrganizationIds);

    return {
      apply: query =>
        query.where(builder => {
          builder
            .where(nonSchoolYearFilter => {
              nonSchoolYearFilter
                .where('academicsessions.type', '!=', 'schoolYear')
                .whereIn('academicsessions.educationOrganizationId', accessibleOrgIds);
            })
            .orWhere(schoolYearFilter => {
              schoolYearFilter
                .where('academicsessions.type', 'schoolYear')
                .where(schoolYearOrgBuilder => {
                  schoolYearOrgBuilder
                    .whereIn('academicsessions.educationOrganizationId', schoolYearSourceOrgQuery())
                    .orWhereIn('academicsessions.educationOrganizationId', accessibleOrgIds);
                });
            });
        })
    };
  }

  /**
   * Apply authorization filter to a Knex query
   * @param {Object} query - Knex query builder object
   * @param {Object} authFilter - Authorization filter { field, values } or { apply }
   * @returns {Object} Modified Knex query
   */
  applyAuthorizationFilter(query, authFilter) {
    if (!authFilter) {
      return query;
    }

    if (typeof authFilter.apply === 'function') {
      return authFilter.apply(query);
    }

    if (!authFilter.values) {
      return query;
    }

    if (typeof authFilter.values.toSQL === 'function') {
      return query.whereIn(authFilter.field, authFilter.values);
    }

    // An empty set of accessible education organization IDs means the caller reaches nothing,
    // so the filter must exclude every row. Stated explicitly rather than relying on knex
    // emitting "1 = 0" for an empty whereIn.
    if (authFilter.values.length === 0) {
      return query.whereRaw('1 = 0');
    }

    const stringValues = authFilter.values.map(v => String(v));

    return query.whereIn(authFilter.field, stringValues);
  }

  /**
   * Get authorization filter for any endpoint
   * @param {string} endpoint - Endpoint name (e.g., 'users', 'classes', 'orgs')
   * @param {Array<string>} educationOrganizationIds - Education org IDs to filter by
   * @returns {Object|null} Authorization filter object
   */
  async getAuthorizationFilter(endpoint, educationOrganizationIds) {
    if (!educationOrganizationIds || educationOrganizationIds.length === 0) {
      return null;
    }

    // Restricted to endpoints with a filter of their own, so an unrecognised endpoint falls
    // through to the null return below rather than reaching the pass-through. fullAccess lets
    // callers report that filtering was skipped; apply() keeps the shape uniform for
    // applyAuthorizationFilter.
    if (AUTH_ENDPOINT_NAMES.has(endpoint) && await this.hasFullEducationOrganizationAccess(educationOrganizationIds)) {
      return { fullAccess: true, apply: query => query };
    }

    switch (endpoint) {
      case AUTH_ENDPOINTS.orgs:
        return await this.buildOrgAuthorizationFilter(educationOrganizationIds);

      case AUTH_ENDPOINTS.users:
        return await this.buildUserAuthorizationFilter(educationOrganizationIds);

      case AUTH_ENDPOINTS.classes:
        return await this.buildClassAuthorizationFilter(educationOrganizationIds);

      case AUTH_ENDPOINTS.courses:
        return await this.buildCourseAuthorizationFilter(educationOrganizationIds);

      case AUTH_ENDPOINTS.enrollments:
        return await this.buildEnrollmentAuthorizationFilter(educationOrganizationIds);

      case AUTH_ENDPOINTS.demographics:
        return await this.buildDemographicsAuthorizationFilter(educationOrganizationIds);

      case AUTH_ENDPOINTS.academicSessions:
        return await this.buildAcademicSessionAuthorizationFilter(educationOrganizationIds);

      default:
        logger.warn(`No authorization filter defined for endpoint: ${endpoint}`);
        return null;
    }
  }

}

export { AUTH_ENDPOINTS };
export default AuthorizationQueryService;
