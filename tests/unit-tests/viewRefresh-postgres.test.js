// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

// refreshView with the tracking SQL deploy-dms.js generates, on a real PostgreSQL server and with
// real concurrent transactions. It needs a server, so it runs only when REFRESH_TRACKING_PG is set:
//   REFRESH_TRACKING_PG="host=localhost;port=5435;username=postgres;password=...;database=postgres" \
//     npm test -- tests/unit-tests/viewRefresh-postgres.test.js
// It creates a throwaway database (dropped afterwards) holding a minimal DMS-shaped schema: one
// resource table whose "ContentVersion" a trigger stamps from dms."ChangeVersionSequence" on
// insert and update, a collection table whose changes restamp the resource in the same transaction
// (as DMS's generated TR_<Collection>_Stamp_* triggers do, e.g. edfi."SchoolGradeLevel"), and a
// tracked_changes_edfi table that deletes write to. Other transactions on the server can make a
// run record incomplete state; the tests settle the state before asserting a skip.

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import knex from 'knex';
import { parseConnectionString } from '../../src/config/multi-tenancy-config.js';
import { buildPostgresClientOptions } from '../../src/config/db-connection.js';
import { buildRefreshTrackingSql } from '../../standard/deploy-dms.js';
import { refreshView } from '../../src/services/viewRefresh.js';

const SERVER = process.env.REFRESH_TRACKING_PG;
const DATABASE = `oneroster_refresh_check_${process.pid}`;

const SCHEMA = `
create schema dms;
create sequence dms."ChangeVersionSequence";
create schema edfi;
create table edfi."School" (
  "DocumentId" bigint primary key,
  "NameOfInstitution" text not null,
  "ContentVersion" bigint not null
);
create table edfi."SchoolGradeLevel" (
  "School_DocumentId" bigint not null references edfi."School" on delete cascade,
  "GradeLevel" text not null
);
create schema tracked_changes_edfi;
create table tracked_changes_edfi."School" ("DocumentId" bigint not null, "ChangeVersion" bigint not null);

create function edfi.stamp() returns trigger language plpgsql as $$
begin new."ContentVersion" := nextval('dms."ChangeVersionSequence"'); return new; end $$;
create trigger stamp before insert or update on edfi."School" for each row execute function edfi.stamp();

create function edfi.restamp_school() returns trigger language plpgsql as $$
begin
  update edfi."School" set "ContentVersion" = 0
   where "DocumentId" = coalesce(new."School_DocumentId", old."School_DocumentId");
  return null;
end $$;
create trigger restamp after insert or update or delete on edfi."SchoolGradeLevel" for each row execute function edfi.restamp_school();

create function edfi.track_delete() returns trigger language plpgsql as $$
begin
  insert into tracked_changes_edfi."School" values (old."DocumentId", nextval('dms."ChangeVersionSequence"'));
  return old;
end $$;
create trigger track_delete after delete on edfi."School" for each row execute function edfi.track_delete();

create schema oneroster12;
create materialized view oneroster12.orgs as
  select s."DocumentId" as id, s."NameOfInstitution" as name,
         (select array_agg(g."GradeLevel" order by g."GradeLevel") from edfi."SchoolGradeLevel" g where g."School_DocumentId" = s."DocumentId") as grades
    from edfi."School" s;
-- A projection the tracking function doesn't know
create materialized view oneroster12.classes as select 1 as id;
`;

const TRACKING = buildRefreshTrackingSql(
  { orgs: { resources: ['edfi.School'], deletes: ['tracked_changes_edfi.School'] } },
  ['orgs']
);

function connect(database) {
  const config = { ...parseConnectionString(SERVER, 'postgres'), database };
  return knex({ client: 'pg', connection: buildPostgresClientOptions(config), pool: { min: 0, max: 4 } });
}

(SERVER ? describe : describe.skip)('refreshView change tracking on PostgreSQL', () => {
  let admin;
  let db;
  let savedPlatform;

  const orgs = async () => (await db.raw('select id::int, name, grades from oneroster12.orgs order by id')).rows;
  const state = async () => (await db.raw("select source_version::text as version, complete from oneroster12.refresh_state where view_name = 'orgs'")).rows[0];
  /** Refresh until a run records complete state, so the next run's decision depends only on our writes. */
  const settle = async () => {
    for (let i = 0; i < 20; i++) {
      const result = await refreshView(db, 'orgs');
      if (result.complete) return result;
    }
    throw new Error('Other transactions kept the refresh state incomplete');
  };

  beforeAll(async () => {
    savedPlatform = process.env.PLATFORM;
    process.env.PLATFORM = 'dms';
    admin = connect(parseConnectionString(SERVER, 'postgres').database || 'postgres');
    await admin.raw(`create database ${DATABASE}`);
    db = connect(DATABASE);
    await db.raw(SCHEMA);
    await db.raw(TRACKING);
    await db.raw(`insert into edfi."School" ("DocumentId", "NameOfInstitution") values (1, 'Alpha'), (2, 'Beta')`);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin?.raw(`drop database if exists ${DATABASE} with (force)`);
    await admin?.destroy();
    if (savedPlatform === undefined) delete process.env.PLATFORM; else process.env.PLATFORM = savedPlatform;
  });

  test('refreshes once, then skips while the sources are unchanged', async () => {
    const first = await refreshView(db, 'orgs');
    expect(first).toMatchObject({ refreshed: true, tracked: true });
    await settle();
    expect(await refreshView(db, 'orgs')).toMatchObject({ refreshed: false, tracked: true });
    expect((await orgs()).map(o => o.name)).toEqual(['Alpha', 'Beta']);
  });

  test('a committed insert, collection change and delete each cause a refresh', async () => {
    await settle();
    await db.raw(`insert into edfi."School" ("DocumentId", "NameOfInstitution") values (3, 'Gamma')`);
    expect(await refreshView(db, 'orgs')).toMatchObject({ refreshed: true });
    expect((await orgs()).map(o => o.name)).toEqual(['Alpha', 'Beta', 'Gamma']);

    await settle();
    await db.raw(`insert into edfi."SchoolGradeLevel" values (3, 'Ninth grade')`);
    expect(await refreshView(db, 'orgs')).toMatchObject({ refreshed: true });
    expect((await orgs())[2].grades).toEqual(['Ninth grade']);

    await settle();
    await db.raw(`delete from edfi."School" where "DocumentId" = 3`);
    expect(await refreshView(db, 'orgs')).toMatchObject({ refreshed: true });
    expect((await orgs()).map(o => o.name)).toEqual(['Alpha', 'Beta']);
  });

  test('a write that commits late with a lower version is not missed', async () => {
    await settle();
    const late = await db.transaction();
    try {
      // The late write takes its version first, then stays uncommitted
      await late.raw(`update edfi."School" set "NameOfInstitution" = 'Alpha (late)' where "DocumentId" = 1`);
      const lowVersion = (await late.raw(`select "ContentVersion"::text as v from edfi."School" where "DocumentId" = 1`)).rows[0].v;
      await db.raw(`update edfi."School" set "NameOfInstitution" = 'Beta (early)' where "DocumentId" = 2`);

      const during = await refreshView(db, 'orgs');
      expect(during).toMatchObject({ refreshed: true, complete: false });
      expect(BigInt(lowVersion) < BigInt(during.sourceVersion)).toBe(true);
      expect((await orgs()).map(o => o.name)).toEqual(['Alpha', 'Beta (early)']);

      await late.commit();
      // The late write's version is below the recorded one: only the incomplete state makes this run refresh
      expect(BigInt(lowVersion) <= BigInt((await state()).version)).toBe(true);
    } catch (error) {
      if (!late.isCompleted()) await late.rollback();
      throw error;
    }

    expect(await refreshView(db, 'orgs')).toMatchObject({ refreshed: true });
    expect((await orgs()).map(o => o.name)).toEqual(['Alpha (late)', 'Beta (early)']);
    await settle();
    expect(await refreshView(db, 'orgs')).toMatchObject({ refreshed: false });
  });

  test('a projection the tracking function does not know is refreshed untracked', async () => {
    expect(await refreshView(db, 'classes')).toEqual({ refreshed: true, tracked: false });
  });
});
