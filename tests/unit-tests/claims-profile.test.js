// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import {
  odsClaimsProfile,
  dmsClaimsProfile,
  getClaimsProfile
} from '../../src/platform/claims-profile.js';

// Token payloads decoded from a local Ed-Fi API v8 stack (identifiers redacted)
const dmsSample = name =>
  JSON.parse(fs.readFileSync(new URL(`../../docs/design/dms-samples/${name}`, import.meta.url), 'utf8'));

const ROSTER = 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster.readonly';
const CORE = 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly';

describe('claims profiles', () => {
  test('getClaimsProfile selects by platform', () => {
    expect(getClaimsProfile('ods')).toBe(odsClaimsProfile);
    expect(getClaimsProfile('dms')).toBe(dmsClaimsProfile);
  });

  describe('ODS/API', () => {
    test.each([
      ['a space-delimited string', `${ROSTER}  ${CORE}`, [ROSTER, CORE]],
      ['an array of strings', [ROSTER, `${CORE} ${ROSTER}`, 42], [ROSTER, CORE]],
      ['a missing claim', undefined, []]
    ])('reads scopes from %s', (label, scope, expected) => {
      expect([...odsClaimsProfile.getScopes({ scope })]).toEqual(expected);
    });

    test('reads no scopes without a payload', () => {
      expect(odsClaimsProfile.getScopes(undefined).size).toBe(0);
    });

    test.each([
      [{ educationOrganizationId: '255901' }, ['255901']],
      [{ educationOrganizationId: ['255901', 255901107] }, ['255901', 255901107]],
      [{}, []],
      [undefined, []]
    ])('reads education organizations from %p', (payload, expected) => {
      expect(odsClaimsProfile.getEducationOrganizationIds(payload)).toEqual(expected);
    });

    test('reads the tenant claim', () => {
      expect(odsClaimsProfile.getTenantId({ tenantId: 'Tenant1' })).toBe('Tenant1');
      expect(odsClaimsProfile.getTenantId({})).toBeUndefined();
      expect(odsClaimsProfile.getTenantId(undefined)).toBeNull();
    });

    test.each([
      [{ odsInstanceId: '3' }, 3],
      [{ ods_instance_id: 4 }, 4],
      [{ OdsInstanceId: '5' }, 5],
      [{}, null],
      [undefined, null]
    ])('reads the singular ODS instance claim from %p', (payload, expected) => {
      expect(odsClaimsProfile.getOdsInstanceId(payload)).toBe(expected);
    });

    test('reads the plural odsInstances claim', () => {
      const odsInstances = JSON.stringify({
        OdsInstances: [{ OdsInstanceId: 3, OdsInstanceContext: { ContextKey: 'schoolYear', ContextValue: '2026' } }]
      });

      expect(odsClaimsProfile.getOdsInstances({ odsInstances })).toEqual([
        { OdsInstanceId: 3, OdsInstanceContext: { ContextKey: 'schoolYear', ContextValue: '2026' } }
      ]);
      expect(odsClaimsProfile.getOdsInstances({ odsInstances: 'not json' })).toEqual([]);
      expect(odsClaimsProfile.getOdsInstances({})).toEqual([]);
    });
  });

  describe('DMS', () => {
    test('reads a captured LEA vendor token', () => {
      const payload = dmsSample('token-lea.payload.json');

      expect(dmsClaimsProfile.getClaimSetName(payload)).toBe('OneRoster-ReadOnly');
      expect(dmsClaimsProfile.getEducationOrganizationIds(payload)).toEqual(['255901']);
      expect(dmsClaimsProfile.getDataStoreIds(payload)).toEqual(['1']);
      expect(dmsClaimsProfile.getTenantId(payload)).toBeNull();
    });

    test('reads a captured CMS read-only token as having no data stores or ed-orgs', () => {
      const payload = dmsSample('token-cms-ro.payload.json');

      expect(payload.dataStoreIds).toBe('');
      expect(dmsClaimsProfile.getDataStoreIds(payload)).toEqual([]);
      expect(dmsClaimsProfile.getEducationOrganizationIds(payload)).toEqual([]);
    });

    test.each([
      ['255901,255902', ['255901', '255902']],
      [' 255901 , ,255902 ', ['255901', '255902']],
      [['255901', '255902,255903'], ['255901', '255902', '255903']],
      [255901, ['255901']],
      ['', []],
      [undefined, []],
      [{ id: 1 }, []]
    ])('parses educationOrganizationIds %p', (value, expected) => {
      expect(dmsClaimsProfile.getEducationOrganizationIds({ educationOrganizationIds: value })).toEqual(expected);
    });

    test('treats an absent dataStoreIds claim (Keycloak) as no data stores', () => {
      expect(dmsClaimsProfile.getDataStoreIds({})).toEqual([]);
      expect(dmsClaimsProfile.getDataStoreIds(undefined)).toEqual([]);
    });

    test('reads the claim-set name from scope', () => {
      expect(dmsClaimsProfile.getClaimSetName({ scope: ' OneRoster-ReadOnly ' })).toBe('OneRoster-ReadOnly');
      expect(dmsClaimsProfile.getClaimSetName({ scope: '' })).toBeNull();
      expect(dmsClaimsProfile.getClaimSetName({})).toBeNull();
    });

    describe('scopes from ONEROSTER_CLAIMSET_SCOPES', () => {
      let original;
      beforeEach(() => {
        original = process.env.ONEROSTER_CLAIMSET_SCOPES;
        process.env.ONEROSTER_CLAIMSET_SCOPES = JSON.stringify({
          'OneRoster-ReadOnly': ['roster.readonly', `${'https://purl.imsglobal.org/spec/or/v1p2/scope/'}roster-demographics.readonly`],
          'OneRoster-Core': ['roster-core.readonly']
        });
      });
      afterEach(() => {
        if (original === undefined) delete process.env.ONEROSTER_CLAIMSET_SCOPES;
        else process.env.ONEROSTER_CLAIMSET_SCOPES = original;
      });

      test('maps the claim set in scope to OneRoster scope URIs', () => {
        expect([...dmsClaimsProfile.getScopes(dmsSample('token-lea.payload.json'))]).toEqual([
          ROSTER, 'https://purl.imsglobal.org/spec/or/v1p2/scope/roster-demographics.readonly'
        ]);
        expect([...dmsClaimsProfile.getScopes({ scope: 'OneRoster-Core' })]).toEqual([CORE]);
      });

      test('gives an unmapped claim set or a token without one no scopes', () => {
        expect(dmsClaimsProfile.getScopes({ scope: 'SeedLoader' }).size).toBe(0);
        expect(dmsClaimsProfile.getScopes({}).size).toBe(0);
      });

      test('feeds the scope check through getClaimsProfile', () => {
        expect(getClaimsProfile('dms').getScopes({ scope: 'OneRoster-Core' }).has(CORE)).toBe(true);
      });
    });
  });
});
