// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { describe, test, expect } from '@jest/globals';
import {
  DEFAULT_DMS_HTTP_TIMEOUT_MS, dmsTransportWarnings, getDmsDataStoreSettings, getDmsTokenSettings, validateDmsSettings
} from '../../src/config/dms-config.js';

const BASE = {
  OAUTH2_ISSUER: 'http://ed-fi-api-config:8081',
  OAUTH2_JWKS_URL: 'https://cms.example.org/.well-known/jwks.json',
  ONEROSTER_CLAIMSET_SCOPES: '{"OneRoster-ReadOnly":["roster.readonly"]}',
  CONFIG_SERVICE_URL: 'https://cms.example.org',
  CONFIG_SERVICE_CLIENT_ID: 'id',
  CONFIG_SERVICE_CLIENT_SECRET: 'secret',
  CONFIG_SERVICE_ENCRYPTION_KEY: 'key'
};

describe('DMS_HTTP_TIMEOUT_MS', () => {
  test('defaults to 10 s for the Configuration Service and the token issuer', () => {
    expect(DEFAULT_DMS_HTTP_TIMEOUT_MS).toBe(10_000);
    expect(getDmsDataStoreSettings(BASE).timeoutMs).toBe(10_000);
    expect(getDmsTokenSettings(BASE).timeoutMs).toBe(10_000);
    expect(getDmsDataStoreSettings({ ...BASE, DMS_HTTP_TIMEOUT_MS: '2500' }).timeoutMs).toBe(2500);
  });

  test('must be a positive integer', () => {
    expect(validateDmsSettings(BASE, false)).toEqual([]);
    for (const value of ['0', '-5', '1.5', 'soon']) {
      expect(validateDmsSettings({ ...BASE, DMS_HTTP_TIMEOUT_MS: value }, false))
        .toEqual(['DMS_HTTP_TIMEOUT_MS must be a positive integer (milliseconds) if set']);
    }
  });
});

describe('dmsTransportWarnings', () => {
  test('none for https or loopback http', () => {
    expect(dmsTransportWarnings(BASE)).toEqual([]);
    expect(dmsTransportWarnings({ ...BASE, CONFIG_SERVICE_URL: 'http://localhost:8081', OAUTH2_JWKS_URL: 'http://127.0.0.1:8081/jwks' })).toEqual([]);
  });

  test('warns when the client secret or the signing keys would cross the network in clear', () => {
    const warnings = dmsTransportWarnings({ ...BASE, CONFIG_SERVICE_URL: 'http://config:8081', OAUTH2_METADATA_URL: 'http://config:8081/.well-known/openid-configuration' });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^CONFIG_SERVICE_URL uses http: the Configuration Service client secret/);
    expect(warnings[1]).toMatch(/^OAUTH2_METADATA_URL uses http: the token signing keys/);
  });

  test('ignores CONFIG_SERVICE_URL in static DATA_STORES mode, which does not call it', () => {
    expect(dmsTransportWarnings({ ...BASE, CONFIG_SERVICE_URL: 'http://config:8081', DATA_STORES: '{"1":{"ConnectionString":"host=x"}}' })).toEqual([]);
  });
});
