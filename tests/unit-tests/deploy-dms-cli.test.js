// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// standard/deploy-dms.js --from-cms run as a process, with the Configuration Service secrets only in
// the secrets plugin (APP_SECRETS_MODULE) and PLATFORM unset, as an operator might run it.

import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MISSING_SETTINGS = 'needs baseUrl, clientId and clientSecret';

/** Run the CLI with only the given variables (and PATH); resolves with its exit code and stderr. */
function runDeploy(env) {
  return new Promise(resolve => {
    execFile(process.execPath, ['standard/deploy-dms.js', '--from-cms'], { cwd: root, env: { PATH: process.env.PATH, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stderr }));
  });
}

describe('deploy-dms.js --from-cms', () => {
  let dir;
  // Nothing listens on port 9 (discard), so the first Configuration Service call fails fast
  const cms = { CONFIG_SERVICE_URL: 'http://127.0.0.1:9', CONFIG_SERVICE_CLIENT_ID: 'oneroster', DMS_HTTP_TIMEOUT_MS: '2000', LOG_LEVEL: 'error' };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'deploy-dms-cli-'));
    await writeFile(path.join(dir, 'secrets.mjs'),
      "export async function loadAppSecrets() { return { configServiceClientSecret: 'synthetic-secret' }; }\n");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('without the secret it stops before any request', async () => {
    const { code, stderr } = await runDeploy(cms);
    expect(code).toBe(1);
    expect(stderr).toContain(MISSING_SETTINGS);
  });

  test('takes the client secret from the secrets plugin, with PLATFORM unset', async () => {
    const { code, stderr } = await runDeploy({ ...cms, APP_SECRETS_MODULE: path.join(dir, 'secrets.mjs') });
    // It gets as far as calling the Configuration Service, which isn't there
    expect(code).toBe(1);
    expect(stderr).not.toContain(MISSING_SETTINGS);
    expect(stderr).toMatch(/^deploy-dms: /m);
  });
});
