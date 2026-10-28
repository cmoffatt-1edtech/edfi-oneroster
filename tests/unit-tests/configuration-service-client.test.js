// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect } from '@jest/globals';
import { ConfigurationServiceClient, ConfigurationServiceError } from '../../src/platform/dms/configuration-service-client.js';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** A fake CMS: counts token requests and records data requests. */
function createFakeCms({ dataStatus = [200] } = {}) {
  const calls = { tokens: 0, data: [] };
  let issued = 0;
  const fetchImpl = jest.fn(async (url, init = {}) => {
    if (url.endsWith('/connect/token')) {
      calls.tokens++;
      calls.tokenBody = Object.fromEntries(new URLSearchParams(init.body));
      return jsonResponse(200, { access_token: `token-${++issued}`, expires_in: 1800 });
    }
    calls.data.push({ url, headers: init.headers });
    const status = dataStatus.length > 1 ? dataStatus.shift() : dataStatus[0];
    return jsonResponse(status, status === 200 ? [{ id: 1 }] : { error: 'x' });
  });
  return { fetchImpl, calls };
}

function createClient(fake, now = () => 0) {
  return new ConfigurationServiceClient({
    baseUrl: 'http://cms:8081/', clientId: 'ro-client', clientSecret: 'ro-secret', fetchImpl: fake.fetchImpl, now
  });
}

describe('ConfigurationServiceClient', () => {
  test('requests a client-credentials token with the read-only scope as form fields', async () => {
    const fake = createFakeCms();
    await createClient(fake).getDataStores();

    expect(fake.calls.tokenBody).toEqual({
      grant_type: 'client_credentials',
      client_id: 'ro-client',
      client_secret: 'ro-secret',
      scope: 'edfi_admin_api/authMetadata_readonly_access'
    });
    expect(fake.calls.data[0].url).toBe('http://cms:8081/v3/dataStores');
    expect(fake.calls.data[0].headers.Authorization).toBe('Bearer token-1');
  });

  test('reuses one token across requests, including concurrent ones', async () => {
    const fake = createFakeCms();
    const client = createClient(fake);

    await Promise.all([client.getDataStores(), client.getDataStores(), client.getTenants()]);
    await client.getDataStores();

    expect(fake.calls.tokens).toBe(1);
    expect(fake.calls.data).toHaveLength(4);
  });

  test('gets a new token a minute before the old one expires', async () => {
    const fake = createFakeCms();
    let clock = 0;
    const client = createClient(fake, () => clock);

    await client.getDataStores();
    clock = (1800 - 61) * 1000;
    await client.getDataStores();
    expect(fake.calls.tokens).toBe(1);

    clock = (1800 - 59) * 1000;
    await client.getDataStores();
    expect(fake.calls.tokens).toBe(2);
  });

  test('sends the Tenant header for tenant-scoped reads', async () => {
    const fake = createFakeCms();
    await createClient(fake).getApiClient('lea key/1', 'Tenant1');

    expect(fake.calls.data[0].url).toBe('http://cms:8081/v3/apiClients/lea%20key%2F1');
    expect(fake.calls.data[0].headers.Tenant).toBe('Tenant1');
  });

  test('retries once with a new token after a 401', async () => {
    const fake = createFakeCms({ dataStatus: [401, 200] });
    const result = await createClient(fake).getDataStores();

    expect(result).toEqual([{ id: 1 }]);
    expect(fake.calls.tokens).toBe(2);
  });

  test('returns null on 404 and throws on other failures', async () => {
    expect(await createClient(createFakeCms({ dataStatus: [404] })).getApiClient('x', 'T')).toBeNull();

    const error = await createClient(createFakeCms({ dataStatus: [503] })).getDataStores().catch(e => e);
    expect(error).toBeInstanceOf(ConfigurationServiceError);
    expect(error.status).toBe(503);
  });

  test('fails when the token request is refused', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(400, {}));
    const client = new ConfigurationServiceClient({ baseUrl: 'http://cms', clientId: 'a', clientSecret: 'b', fetchImpl });

    await expect(client.getDataStores()).rejects.toThrow('Configuration Service token request failed with 400');
  });
});
