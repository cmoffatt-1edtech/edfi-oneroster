// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  parseRouteQualifierSegments,
  getRouteContextConfig
} from '../../src/config/route-context-config.js';
import { buildRoutePattern } from '../../src/config/ods-context-config.js';

const ENV_KEYS = ['PLATFORM', 'ROUTE_QUALIFIER_SEGMENTS', 'ODS_CONTEXT_ROUTE_TEMPLATE'];

describe('route-context-config', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    ENV_KEYS.forEach(key => delete process.env[key]);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  describe('parseRouteQualifierSegments', () => {
    test.each([undefined, '', ' , '])('treats %p as no segments', (value) => {
      expect(parseRouteQualifierSegments(value)).toEqual({ names: [], errors: [] });
    });

    test('splits, trims and drops empty entries like DMS', () => {
      expect(parseRouteQualifierSegments(' districtId, ,schoolYear ,')).toEqual({
        names: ['districtId', 'schoolYear'],
        errors: []
      });
    });

    test('rejects names that cannot be route parameters', () => {
      const { errors } = parseRouteQualifierSegments('schoolYear,school-year,2026');
      expect(errors).toEqual([
        'ROUTE_QUALIFIER_SEGMENTS contains names that are not valid route parameter names: school-year, 2026'
      ]);
    });

    test('rejects names this API already uses as route parameters', () => {
      const { errors } = parseRouteQualifierSegments('TenantId,schoolYear,ID');
      expect(errors).toEqual([
        "ROUTE_QUALIFIER_SEGMENTS uses names reserved by this API's routes: TenantId, ID"
      ]);
    });

    test('rejects names that collide case-insensitively, as DMS does', () => {
      const { errors } = parseRouteQualifierSegments('schoolYear,districtId,SchoolYear');
      expect(errors).toEqual([
        'ROUTE_QUALIFIER_SEGMENTS contains names that are equal under case-insensitive comparison: schoolYear, SchoolYear'
      ]);
    });
  });

  describe('getRouteContextConfig', () => {
    test('is null on the ODS/API without a context template', () => {
      expect(getRouteContextConfig()).toBeNull();
    });

    test('keeps the parsed ODS template and adds its parameter as the only segment', () => {
      process.env.ODS_CONTEXT_ROUTE_TEMPLATE = '{schoolYearFromRoute:range(2026,2027)}';

      expect(getRouteContextConfig()).toEqual({
        parameterName: 'schoolYearFromRoute',
        constraintType: 'range',
        constraintArgs: '2026,2027',
        fullConstraint: 'range(2026,2027)',
        source: 'odsTemplate',
        parameterNames: ['schoolYearFromRoute']
      });
    });

    test('ignores ROUTE_QUALIFIER_SEGMENTS on the ODS/API', () => {
      process.env.ROUTE_QUALIFIER_SEGMENTS = 'districtId,schoolYear';
      expect(getRouteContextConfig()).toBeNull();
    });

    test('uses the qualifier segments in order on DMS', () => {
      process.env.PLATFORM = 'dms';
      process.env.ROUTE_QUALIFIER_SEGMENTS = 'districtId,schoolYear';

      expect(getRouteContextConfig()).toEqual({
        source: 'qualifierSegments',
        parameterNames: ['districtId', 'schoolYear']
      });
    });

    test('ignores ODS_CONTEXT_ROUTE_TEMPLATE on DMS', () => {
      process.env.PLATFORM = 'dms';
      process.env.ODS_CONTEXT_ROUTE_TEMPLATE = '{schoolYearFromRoute:int}';
      expect(getRouteContextConfig()).toBeNull();
    });

    test('throws on invalid qualifier segments on DMS', () => {
      process.env.PLATFORM = 'dms';
      process.env.ROUTE_QUALIFIER_SEGMENTS = 'school-year';
      expect(() => getRouteContextConfig()).toThrow('not valid route parameter names: school-year');
    });
  });

  describe('buildRoutePattern', () => {
    test.each([
      [false, null, ''],
      [true, null, '/:tenantId'],
      [false, { parameterName: 'schoolYearFromRoute' }, '/:schoolYearFromRoute'],
      [true, { parameterName: 'schoolYearFromRoute' }, '/:tenantId/:schoolYearFromRoute'],
      [false, { parameterNames: ['districtId', 'schoolYear'] }, '/:districtId/:schoolYear'],
      [true, { parameterNames: ['districtId', 'schoolYear'] }, '/:tenantId/:districtId/:schoolYear'],
      [true, { parameterName: 'ignored', parameterNames: ['schoolYear'] }, '/:tenantId/:schoolYear']
    ])('multi-tenant %p with %p builds %p', (multiTenancyEnabled, contextConfig, expected) => {
      expect(buildRoutePattern(multiTenancyEnabled, contextConfig)).toBe(expected);
    });
  });
});
