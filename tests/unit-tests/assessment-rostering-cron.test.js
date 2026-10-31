// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

// pg-boss stand-in: records the queues it is asked to schedule and unschedule
const calls = { schedule: [], unschedule: [], work: [] };
class FakePgBoss {
  async start() {}
  on() {}
  async createQueue() {}
  async work(queue) { calls.work.push(queue); }
  async schedule(queue) { calls.schedule.push(queue); }
  async unschedule(queue) { calls.unschedule.push(queue); }
}

jest.unstable_mockModule('pg-boss', () => ({ PgBoss: FakePgBoss }));
jest.unstable_mockModule('../../src/config/knex-factory.js', () => ({
  knexManager: { on: () => {}, getOdsInstances: () => [] }
}));

const { initializeCronJobs } = await import('../../src/services/cronService.js');
const { ASSESSMENT_VIEWS } = await import('../../src/config/assessment-rostering.js');

const ASSESSMENT_QUEUES = ASSESSMENT_VIEWS.map(view => `oneroster-refresh-${view}`);
const ENV_KEYS = ['DB_TYPE', 'PG_BOSS_CONNECTION_CONFIG', 'PGBOSS_CRON', 'ASSESSMENT_ROSTERING_ENABLED'];

describe('view refresh schedules for assessment rostering', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    process.env.DB_TYPE = 'postgres';
    process.env.PG_BOSS_CONNECTION_CONFIG = JSON.stringify({ adminConnection: 'host=localhost;port=5432;database=EdFi_Admin;username=u' });
    process.env.PGBOSS_CRON = '*/15 * * * *';
    for (const list of Object.values(calls)) list.length = 0;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('flag on: the assessment views are worked and scheduled', async () => {
    process.env.ASSESSMENT_ROSTERING_ENABLED = 'true';
    await initializeCronJobs();

    expect(calls.work).toEqual(expect.arrayContaining(ASSESSMENT_QUEUES));
    expect(calls.schedule).toEqual(expect.arrayContaining(ASSESSMENT_QUEUES));
    expect(calls.unschedule).toEqual([]);
  });

  test('flag off: schedules an earlier run left for them are removed', async () => {
    process.env.ASSESSMENT_ROSTERING_ENABLED = 'false';
    await initializeCronJobs();

    expect(calls.work).toHaveLength(7);
    expect(calls.schedule).toHaveLength(7);
    expect(calls.schedule).not.toEqual(expect.arrayContaining([ASSESSMENT_QUEUES[0]]));
    expect(calls.unschedule).toEqual(ASSESSMENT_QUEUES);
  });
});
