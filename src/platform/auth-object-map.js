// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { getPlatform, PLATFORMS } from '../config/platform.js';

/**
 * Names of the Ed-Fi `auth` objects the relationship filters read, and of the hidden person-key
 * columns the oneroster12 projections expose for them, per platform.
 *
 * - tables / columns: the education organization hierarchy and the ed-org-to-person mappings.
 * - contactMappings: candidates for the ed-org-to-contact mapping, in preference order; the
 *   first one present in the database is used (the ODS renamed parent to contact in DS 5).
 * - projectionColumns: the oneroster12 columns holding the person key the mappings return.
 * - caseSensitiveNames: names are mixed case and must be quoted on PostgreSQL. ODS names are
 *   lower case, so they resolve unquoted on both engines.
 * - directClaimMatch: an ed-org named in the token claim is reachable even without a hierarchy
 *   row, as DMS's own relationship authorization treats it.
 */

export const ODS_AUTH_OBJECT_MAP = Object.freeze({
  platform: PLATFORMS.ODS,
  caseSensitiveNames: false,
  directClaimMatch: false,
  tables: Object.freeze({
    orgToOrg: 'educationorganizationidtoeducationorganizationid',
    orgToStudent: 'educationorganizationidtostudentusi',
    orgToStaff: 'educationorganizationidtostaffusi'
  }),
  columns: Object.freeze({
    sourceOrgId: 'sourceeducationorganizationid',
    targetOrgId: 'targeteducationorganizationid',
    student: 'studentusi',
    staff: 'staffusi'
  }),
  contactMappings: Object.freeze([
    Object.freeze({ tableName: 'educationorganizationidtocontactusi', personColumn: 'contactusi' }),
    Object.freeze({ tableName: 'educationorganizationidtoparentusi', personColumn: 'parentusi' })
  ]),
  projectionColumns: Object.freeze({
    participant: 'participantUSI',
    student: 'studentUSI'
  })
});

// DMS provisions the same hierarchy table (same name and columns, PascalCase) and keys the person
// views by DocumentId. Checked against a DS 5.2 data store on dms-pre-8.1.0-beta2.3.
export const DMS_AUTH_OBJECT_MAP = Object.freeze({
  platform: PLATFORMS.DMS,
  caseSensitiveNames: true,
  directClaimMatch: true,
  tables: Object.freeze({
    orgToOrg: 'EducationOrganizationIdToEducationOrganizationId',
    orgToStudent: 'EducationOrganizationIdToStudentDocumentId',
    orgToStaff: 'EducationOrganizationIdToStaffDocumentId'
  }),
  columns: Object.freeze({
    sourceOrgId: 'SourceEducationOrganizationId',
    targetOrgId: 'TargetEducationOrganizationId',
    student: 'Student_DocumentId',
    staff: 'Staff_DocumentId'
  }),
  contactMappings: Object.freeze([
    Object.freeze({ tableName: 'EducationOrganizationIdToContactDocumentId', personColumn: 'Contact_DocumentId' })
  ]),
  projectionColumns: Object.freeze({
    participant: 'participantDocumentId',
    student: 'studentDocumentId'
  })
});

const MAPS = {
  [PLATFORMS.ODS]: ODS_AUTH_OBJECT_MAP,
  [PLATFORMS.DMS]: DMS_AUTH_OBJECT_MAP
};

/**
 * @param {string} [platform] - Defaults to the configured PLATFORM
 */
export function getAuthObjectMap(platform = getPlatform()) {
  return MAPS[platform];
}
