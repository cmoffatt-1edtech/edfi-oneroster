// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  settingsFromEnvFiles, partitionDifferences, compareCollection, compareResponses, runOdsVsDms, runDmsRecord, runDmsVsRecording
} from '../compare-api-ods-dms.js';

const odsEnvText = [
  'BASE_URL=https://localhost/',
  'ODS_API_VIRTUAL_NAME=api',
  'ONEROSTER_API_VIRTUAL_NAME=oneroster-api',
  'LEA_KEY=lea-key',
  'LEA_SECRET=lea-secret',
  'SCHOOL_KEY=school-key',
  'SCHOOL_SECRET=school-secret',
  'POSTGRES_PASSWORD=not-used'
].join('\n');

const dmsEnvText = [
  '# written by setup-dms-clients.ps1',
  "DMS_ONEROSTER_URL='http://localhost:3200'",
  "DMS_TOKEN_URL='http://localhost:8080/oauth/token'",
  "DMS_LEA_KEY='dms-lea'",
  "DMS_LEA_SECRET='a$b#c!d'",
  "CMS_URL='http://localhost:8081'"
].join('\n');

describe('settingsFromEnvFiles', () => {
  test('maps the ODS stack env file to ODS_* settings', () => {
    expect(settingsFromEnvFiles({ odsEnvText }, {})).toEqual({
      ODS_LEA_KEY: 'lea-key',
      ODS_LEA_SECRET: 'lea-secret',
      ODS_SCHOOL_KEY: 'school-key',
      ODS_SCHOOL_SECRET: 'school-secret',
      ODS_ONEROSTER_URL: 'https://localhost/oneroster-api',
      ODS_TOKEN_URL: 'https://localhost/api/oauth/token'
    });
  });

  test('takes only DMS_* values from the clients file, keeping single-quoted values literal', () => {
    expect(settingsFromEnvFiles({ dmsEnvText }, {})).toEqual({
      DMS_ONEROSTER_URL: 'http://localhost:3200',
      DMS_TOKEN_URL: 'http://localhost:8080/oauth/token',
      DMS_LEA_KEY: 'dms-lea',
      DMS_LEA_SECRET: 'a$b#c!d'
    });
  });

  test('variables already in the environment win over the files', () => {
    const settings = settingsFromEnvFiles({ odsEnvText, dmsEnvText }, { ODS_LEA_KEY: 'exported', DMS_ONEROSTER_URL: 'http://other' });
    expect(settings.ODS_LEA_KEY).toBeUndefined();
    expect(settings.DMS_ONEROSTER_URL).toBeUndefined();
    expect(settings.ODS_SCHOOL_KEY).toBe('school-key');
  });

  test('no files, no settings', () => {
    expect(settingsFromEnvFiles({}, {})).toEqual({});
  });
});

describe('partitionDifferences', () => {
  const diffs = [
    { label: 'lea users', sourcedId: 'a', kind: 'only DMS' },
    { label: 'lea users', sourcedId: 'b', kind: 'only DMS' },
    { label: 'lea users', sourcedId: 'a', kind: 'differs' },
    { label: 'error: no token', kind: 'error response differs' }
  ];

  test('an entry with sourcedIds explains only those items, for its label and kind', () => {
    const known = [{ label: 'lea users', kind: 'only DMS', sourcedIds: ['a'], reason: 'r1' }];
    const { explained, unexplained } = partitionDifferences(diffs, known);
    expect(explained).toEqual([{ label: 'lea users', sourcedId: 'a', kind: 'only DMS', reason: 'r1' }]);
    expect(unexplained.map(d => `${d.sourcedId}/${d.kind}`)).toEqual(['b/only DMS', 'a/differs', 'undefined/error response differs']);
  });

  test('an entry without sourcedIds explains every difference with its label and kind', () => {
    const known = [{ label: 'error: no token', kind: 'error response differs', reason: 'r2' }];
    expect(partitionDifferences(diffs, known).explained).toHaveLength(1);
  });

  test('no known differences leaves everything unexplained', () => {
    expect(partitionDifferences(diffs).unexplained).toHaveLength(4);
  });
});

describe('compareCollection', () => {
  const user = id => ({ sourcedId: id, givenName: id, dateLastModified: '2026-10-28T00:00:00.000Z' });

  test('identical collections have no differences', () => {
    const { row, diffs } = compareCollection('lea users', [user('a'), user('b')], [user('b'), user('a')]);
    expect(diffs).toEqual([]);
    expect(row).toMatchObject({ identical: 2, duplicates: 0, sameOrder: false });
  });

  test('a sourcedId repeated on either side is a difference, though the items match', () => {
    const { row, diffs } = compareCollection('lea users', [user('a'), user('b')], [user('a'), user('a'), user('b')]);
    expect(row.duplicates).toBe(1);
    expect(diffs).toEqual([{ label: 'lea users', sourcedId: 'a', kind: 'duplicate on DMS', count: 2 }]);

    const ods = compareCollection('lea users', [user('a'), user('a')], [user('a')]);
    expect(ods.diffs.map(d => d.kind)).toEqual(['duplicate on ODS']);
  });

  test('names the sides as given', () => {
    const { diffs } = compareCollection('lea users', [user('a')], [user('b')], ['PostgreSQL', 'SQL Server']);
    expect(diffs.map(d => d.kind)).toEqual(['only PostgreSQL', 'only SQL Server']);
  });
});

describe('compareResponses', () => {
  const org = (id, extra = {}) => ({ sourcedId: id, name: id, ...extra });
  const responses = (orgs, singles = {}, errors = {}) => ({
    collections: { 'lea orgs': orgs }, singles: { 'lea orgs': singles }, errors
  });

  test('drops side A items of excluded education organizations, users and their demographics', () => {
    // md5('5'): the excluded org itself, a user only there, and that user's demographics
    const excludedOrg = 'e4da3b7fbbce2345d7772b0674a318d5';
    const a = {
      collections: {
        'lea users': [{ sourcedId: 'u1', orgs: [{ sourcedId: excludedOrg }] }, { sourcedId: 'u2', orgs: [{ sourcedId: 'o' }] }],
        'lea demographics': [{ sourcedId: 'u1' }, { sourcedId: 'u2' }],
        'lea orgs': [org(excludedOrg), org('o')]
      },
      singles: {},
      errors: {}
    };
    const b = {
      collections: { 'lea users': [{ sourcedId: 'u2', orgs: [{ sourcedId: 'o' }] }], 'lea demographics': [{ sourcedId: 'u2' }], 'lea orgs': [org('o')] },
      singles: {},
      errors: {}
    };
    expect(compareResponses(a, b, { excludedEdOrgs: ['5'] }).diffs).toEqual([]);
    expect(compareResponses(a, b).diffs.map(d => d.kind)).toEqual(['only ODS', 'only ODS', 'only ODS']);
  });

  test('compares single items without dateLastModified, and a missing one as a difference', () => {
    const one = { status: 200, body: { org: org('o', { dateLastModified: '2026-01-01' }) } };
    const later = { status: 200, body: { org: org('o', { dateLastModified: '2026-02-02' }) } };
    expect(compareResponses(responses([org('o')], { o: one }), responses([org('o')], { o: later })).diffs).toEqual([]);
    const { diffs } = compareResponses(responses([org('o')], { o: one }), responses([org('o')], {}));
    expect(diffs.map(d => [d.label, d.kind])).toEqual([['lea orgs/:id', 'single item differs']]);
  });

  test('requires the roster-core case to be refused on side A as well as identical', () => {
    const allowed = { status: 200, body: { demographics: [] } };
    const refused = { status: 403, body: { imsx_codeMajor: 'failure' } };
    const core = 'core scope on demographics';
    expect(compareResponses(responses([], {}, { [core]: refused }), responses([], {}, { [core]: refused })).diffs).toEqual([]);
    expect(compareResponses(responses([], {}, { [core]: allowed }), responses([], {}, { [core]: allowed })).diffs).toHaveLength(1);
  });
});

// The whole runner against fake services that agree except for one repeated DMS user
describe('runOdsVsDms', () => {
  const ENV = {
    ODS_ONEROSTER_URL: 'http://ods', ODS_TOKEN_URL: 'http://ods-auth/oauth/token',
    ODS_LEA_KEY: 'k', ODS_LEA_SECRET: 's', ODS_SCHOOL_KEY: 'k', ODS_SCHOOL_SECRET: 's',
    DMS_ONEROSTER_URL: 'http://dms', DMS_TOKEN_URL: 'http://dms-auth/oauth/token',
    DMS_LEA_KEY: 'k', DMS_LEA_SECRET: 's', DMS_SCHOOL_KEY: 'k', DMS_SCHOOL_SECRET: 's'
  };
  const user = { sourcedId: 'u1', givenName: 'A' };
  let originalEnv;
  let originalFetch;

  function serve(dmsUsers) {
    global.fetch = jest.fn(async url => {
      if (url.endsWith('/oauth/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
      }
      const path = new URL(url).pathname.split('/rostering/v1p2/')[1];
      const body = path === 'users' ? { users: url.startsWith('http://dms') ? dmsUsers : [user] } : {};
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
    });
  }

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = global.fetch;
    delete process.env.DMS_CORE_KEY;
    Object.assign(process.env, ENV);
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    Object.keys(process.env).forEach(k => { if (!(k in originalEnv)) delete process.env[k]; });
    Object.assign(process.env, originalEnv);
  });

  test('passes when the services agree', async () => {
    serve([user]);
    await expect(runOdsVsDms([])).resolves.toBe(0);
  });

  test('fails when DMS returns a user twice', async () => {
    serve([user, user]);
    await expect(runOdsVsDms([])).resolves.toBe(1);
  });

  test('a recording replays against an identical service and catches a changed one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oneroster-recording-'));
    const file = path.join(dir, 'recording.json');
    try {
      serve([user]);
      await expect(runDmsRecord(['--out', file, '--name', 'PostgreSQL'])).resolves.toBe(0);
      const recording = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(recording).toMatchObject({ format: 'oneroster-api-recording/1', name: 'PostgreSQL', service: 'http://dms' });
      expect(recording.responses.collections['lea users']).toEqual([user]);
      expect(JSON.stringify(recording)).not.toContain('access_token');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);

      await expect(runDmsVsRecording(['--recording', file, '--name', 'SQL Server'])).resolves.toBe(0);
      serve([{ ...user, givenName: 'B' }]);
      await expect(runDmsVsRecording(['--recording', file])).resolves.toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
