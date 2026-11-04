#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Assessment rostering authorization matrix: what each caller of tests/dms-parity-fixture.js's
 * ASSESSMENT_VISIBILITY sees, through the service's own OneRosterQueryService and
 * AuthorizationQueryService. Nothing is kept: each database
 * gets one transaction, which is rolled back.
 *
 * In that transaction, on each platform:
 *   1. The fixture is loaded as tests/compare-dms-fixture.js loads it (triggers and foreign keys off),
 *      plus the ed-org hierarchy rows the triggers would have written.
 *   2. Every oneroster12 materialized view is recreated as a plain view in a scratch schema, so it reads
 *      the fixture without refreshing (or locking) the real views.
 *   3. For each caller, the collection, single-record and sub-collection queries run against the
 *      scratch schema with the caller's ed-org claim, and the fixture rows returned are compared with
 *      the expected ones. The callers: each of ASSESSMENT_VISIBILITY's organizations, the pairs in
 *      ASSESSMENT_CLAIM_PAIRS (the union of what each sees), and one claiming every published
 *      organization (ASSESSMENT_FULL_ACCESS_VISIBILITY). Offerings and enrollments must include nothing
 *      outside the fixture, except for the full-access caller.
 *
 * On SQL Server (--engine mssql) the oneroster12 objects are tables filled by refresh procedures, so
 * step 2 runs the oneroster12.sp_refresh_<table> procedures inside the transaction instead (in
 * sp_refresh_all's order; sp_refresh_all itself refuses an open transaction): the real tables hold
 * the fixture until the rollback, and readers of them wait until then. Point it at a copy of the ODS or
 * data store, not one serving traffic. tests/mssql-fixture-loader.js loads the fixture (foreign keys
 * and triggers off for the tables it writes, negative explicit ids so no identity or sequence moves).
 * Identity values the refresh history uses are not rolled back.
 *
 * Usage:
 *   ODS_PG="host=...;..." DMS_PG="host=...;..." node tests/assessment-auth-matrix.js [--platforms ods]
 *   ODS_MSSQL="server=...;..." DMS_MSSQL="server=...;..." node tests/assessment-auth-matrix.js --engine mssql [--platforms ods]
 * Superuser logins (session_replication_role on PostgreSQL; ALTER TABLE and IDENTITY_INSERT on SQL
 * Server). tests/assessment-auth-matrix.sh runs the PostgreSQL check in a container on both local
 * stacks' Docker networks.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import knexFactory from 'knex';
import { parseConnectionString } from '../src/config/multi-tenancy-config.js';
import { buildKnexConfig, buildPostgresClientOptions } from '../src/config/db-connection.js';
import OneRosterQueryService from '../src/services/database/OneRosterQueryService.js';
import AuthorizationQueryService from '../src/services/database/AuthorizationQueryService.js';
import { ODS_AUTH_OBJECT_MAP, DMS_AUTH_OBJECT_MAP } from '../src/platform/auth-object-map.js';
import { PLATFORMS, Loader, loadNameMap, readDefinitions, readSequences, changedSequences } from './compare-dms-fixture.js';
import {
  ASSESSMENT_VISIBILITY, ASSESSMENT_FIXTURE_IDS, ASSESSMENT_CLAIM_PAIRS, ASSESSMENT_FULL_ACCESS_VISIBILITY,
  FIXTURE, toOdsHierarchyRows, toDmsHierarchyRows
} from './dms-parity-fixture.js';
import { MSSQL_PLATFORMS, MssqlLoader, loadMssqlNameMap, readIdentities, readMssqlSequences } from './mssql-fixture-loader.js';
import { REFRESH_ORDER } from '../standard/deploy-dms.js';

const SCRATCH = 'oneroster12_authmatrix';
const VIEWS = ['assessments', 'assessmentofferings', 'assessmentenrollments'];
const PARENTS = { assessmentofferings: ['assessments', 'assessmentSourcedId'], assessmentenrollments: ['assessmentofferings', 'assessmentOfferingSourcedId'] };
const CONFIG = { defaultSortField: '', allowedFilterFields: ['sourcedId'], selectableFields: ['sourcedId'] };
const AUTH_OBJECTS = { ods: ODS_AUTH_OBJECT_MAP, dms: DMS_AUTH_OBJECT_MAP };
const HIERARCHY_ROWS = { ods: toOdsHierarchyRows, dms: toDmsHierarchyRows };

/** A PostgreSQL array literal, for an array parameter knex would otherwise spread into a list. */
const arrayLiteral = values => `{${values.map(value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;

/** The pg-style query(sql, params) the fixture Loader uses, on a knex transaction. */
function clientFor(trx) {
  return {
    query: (sql, params = []) => trx.raw(
      sql.replace(/\$\d+/g, '?'),
      params.map(value => (Array.isArray(value) ? arrayLiteral(value) : value))
    )
  };
}

const sorted = values => [...values].sort();
const sameSet = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const union = lists => [...new Set(lists.flat())];

/** The callers and what each should see; the full-access claim is every published organization. */
async function matrixCallers(trx, schema) {
  const single = Object.entries(ASSESSMENT_VISIBILITY).map(([org, expected]) => ({ name: org, claim: [org], expected, fixtureOnly: true }));
  const pairs = ASSESSMENT_CLAIM_PAIRS.map(pair => ({
    name: pair.join('+'),
    claim: pair.map(String),
    expected: Object.fromEntries(VIEWS.map(view => [view, union(pair.map(org => ASSESSMENT_VISIBILITY[org][view]))])),
    fixtureOnly: true
  }));
  const published = await trx.withSchema(schema).from('orgs').distinct('educationOrganizationId');
  const full = { name: 'full access', claim: published.map(row => String(row.educationOrganizationId)), expected: ASSESSMENT_FULL_ACCESS_VISIBILITY, fixtureOnly: false };
  return [...single, ...pairs, full];
}

/**
 * Run each caller's collection, single-record and sub-collection queries against the projections in
 * schema, through the service's own query and authorization services, and record what differs from
 * ASSESSMENT_VISIBILITY.
 */
async function checkCallers(trx, schema, platform, failures, report) {
  const service = new OneRosterQueryService(trx, schema);
  service.authService = new AuthorizationQueryService(trx, schema, 'auth', AUTH_OBJECTS[platform.name]);

  const fixtureIds = Object.fromEntries(VIEWS.map(view => [view, new Set(ASSESSMENT_FIXTURE_IDS[view])]));

  for (const { name: caller, claim, expected, fixtureOnly } of await matrixCallers(trx, schema)) {
    report.callers++;
    if (!fixtureOnly) {
      report.checks++;
      if (!(await service.authService.hasFullEducationOrganizationAccess(claim))) {
        failures.push(`${caller}: the claim doesn't reach every published organization`);
      }
    }
    const visible = {};
    for (const view of VIEWS) {
      const parentColumn = PARENTS[view]?.[1];
      const rows = await service.queryMany(view, parentColumn ? { ...CONFIG, selectableFields: ['sourcedId', parentColumn] } : CONFIG,
        { limit: '500' }, null, claim);
      visible[view] = rows;
      const ids = rows.map(row => row.sourcedId);
      const seen = ids.filter(id => fixtureIds[view].has(id));
      report.checks++;
      if (!sameSet(seen, expected[view])) {
        failures.push(`${caller} ${view}: sees ${sorted(seen).join(', ') || 'none'}; expected ${sorted(expected[view]).join(', ') || 'none'}`);
      }
      // Grand Bend's assessments have no defining organization, so everyone sees them; nothing else
      // outside the fixture may leak to a fixture caller
      if (view !== 'assessments' && fixtureOnly) {
        report.checks++;
        const outside = ids.filter(id => !fixtureIds[view].has(id));
        if (outside.length) failures.push(`${caller} ${view}: ${outside.length} row(s) outside the fixture`);
      }

      for (const id of fixtureIds[view]) {
        report.checks++;
        const one = await service.queryOne(view, id, null, claim, ['sourcedId']);
        if (Boolean(one) !== expected[view].includes(id)) {
          failures.push(`${caller} ${view}/${id}: single record ${one ? 'visible' : 'hidden'}, expected ${one ? 'hidden' : 'visible'}`);
        }
      }

      // A sub-collection shows the visible children of the parent, so every visible child appears
      // under its parent and nothing else does
      if (PARENTS[view]) {
        const [parentView, column] = PARENTS[view];
        for (const parentId of fixtureIds[parentView]) {
          report.checks++;
          const children = await service.queryMany(view, CONFIG, { limit: '500' }, { [column]: parentId }, claim);
          const all = await service.queryMany(view, { ...CONFIG, selectableFields: ['sourcedId', column] }, { limit: '500' }, null, null);
          const expectedChildren = all.filter(row => row[column] === parentId && expected[view].includes(row.sourcedId)).map(row => row.sourcedId);
          if (!sameSet(children.map(row => row.sourcedId), expectedChildren)) {
            failures.push(`${caller} ${parentView}/${parentId}/${view}: ${children.length} row(s), expected ${expectedChildren.length}`);
          }
        }
      }
    }

    // Every reference the caller receives resolves for them: an enrollment's offering and an
    // offering's assessment are visible too
    for (const [view, [parentView, column]] of Object.entries(PARENTS)) {
      const parents = new Set(visible[parentView].map(row => row.sourcedId));
      report.checks++;
      const dangling = visible[view].filter(row => !parents.has(row[column]));
      if (dangling.length) failures.push(`${caller} ${view}: ${dangling.length} row(s) whose ${parentView.replace(/s$/, '')} the caller can't see`);
    }
  }
}

async function runPlatform(platform, connectionString) {
  const knex = knexFactory({
    client: 'pg',
    connection: buildPostgresClientOptions(parseConnectionString(connectionString, 'postgres')),
    pool: { min: 1, max: 1 }
  });
  const failures = [];
  const report = { callers: 0, checks: 0 };
  const rollback = new Error('rollback');
  try {
    const sequencesBefore = await readSequences(clientFor(knex));
    await knex.transaction(async trx => {
      const client = clientFor(trx);
      await trx.raw('set local session_replication_role = replica');
      await trx.raw(`set local lock_timeout = '5s'`);
      await trx.raw(`set local statement_timeout = '120s'`);

      const definitions = await readDefinitions(client);
      for (const view of VIEWS) {
        if (!definitions[view]) throw new Error(`oneroster12.${view} is not deployed on ${platform.label}`);
      }

      const loader = new Loader(client, platform.name === 'dms' ? await loadNameMap(client) : null);
      await loader.resolveDescriptors(platform);
      for (const row of [...platform.toRows(FIXTURE, loader.alloc), ...HIERARCHY_ROWS[platform.name](FIXTURE)]) {
        await loader.insert(row);
      }

      await trx.raw(`create schema ${SCRATCH}`);
      for (const [view, sql] of Object.entries(definitions)) {
        await trx.raw(`create view ${SCRATCH}.${view} as ${sql.replace(/;\s*$/, '')}`);
      }

      await checkCallers(trx, SCRATCH, platform, failures, report);
      throw rollback;
    }).catch(error => {
      if (error !== rollback) throw error;
    });

    const changed = changedSequences(sequencesBefore, await readSequences(clientFor(knex)));
    if (changed.length) failures.push(`sequences changed: ${changed.join(', ')}`);
    const { rows } = await knex.raw(platform.fixtureStudents);
    if (rows[0].n !== 0) failures.push(`${rows[0].n} fixture student(s) left after rollback`);
    const scratch = await knex.raw('select count(*)::int as n from pg_namespace where nspname = ?', [SCRATCH]);
    if (scratch.rows[0].n !== 0) failures.push(`scratch schema ${SCRATCH} left after rollback`);
  } finally {
    await knex.destroy();
  }
  return { failures, report };
}

/** Rows of a raw query on knex's mssql client. */
const mssqlRows = result => (Array.isArray(result) ? result : result?.recordset ?? []);

// What the rollback must restore on SQL Server: disabled foreign keys and triggers, and the fixture's rows
const MSSQL_STATE = `select (select count(*) from sys.foreign_keys where is_disabled = 1) as foreignKeys,
                            (select count(*) from sys.triggers where is_disabled = 1) as triggers`;

/** Fixture rows in the oneroster12 assessment tables. */
async function mssqlFixtureRows(knex) {
  let n = 0;
  for (const view of VIEWS) {
    const ids = ASSESSMENT_FIXTURE_IDS[view];
    const [row] = mssqlRows(await knex.raw(
      `select count(*) as n from oneroster12.${view} where sourcedId in (${ids.map(() => '?').join(', ')})`, ids
    ));
    n += row.n;
  }
  return n;
}

async function runMssqlPlatform(platform, connectionString) {
  const config = buildKnexConfig('mssql', parseConnectionString(connectionString, 'mssql'), { pool: { min: 1, max: 1 } });
  config.connection.requestTimeout = 300000;
  const knex = knexFactory(config);
  const failures = [];
  const report = { callers: 0, checks: 0 };
  const rollback = new Error('rollback');
  try {
    const identitiesBefore = await readIdentities(knex);
    const sequencesBefore = await readMssqlSequences(knex);
    const [stateBefore] = mssqlRows(await knex.raw(MSSQL_STATE));
    await knex.transaction(async trx => {
      await trx.raw('set lock_timeout 5000');

      const tables = mssqlRows(await trx.raw(`select name from sys.tables where schema_id = schema_id('oneroster12')`))
        .map(row => row.name.toLowerCase());
      for (const view of VIEWS) {
        if (!tables.includes(view)) throw new Error(`oneroster12.${view} is not deployed on ${platform.label}`);
      }

      const loader = new MssqlLoader(trx, platform.name === 'dms' ? await loadMssqlNameMap(trx) : null);
      await loader.resolveDescriptors(platform);
      for (const row of [...platform.toRows(FIXTURE, loader.alloc), ...HIERARCHY_ROWS[platform.name](FIXTURE)]) {
        await loader.insert(row);
      }

      // sp_refresh_all refuses to run inside a transaction, so run the per-table procedures it runs, in
      // its order. Each commits a nested transaction; a failed one rolls back ours too.
      const [{ last }] = mssqlRows(await trx.raw('select coalesce(max(history_id), 0) as last from oneroster12.refresh_history'));
      const procedures = new Set(mssqlRows(await trx.raw(
        `select lower(name) as name from sys.procedures where schema_id = schema_id('oneroster12')`
      )).map(row => row.name));
      for (const table of REFRESH_ORDER.filter(name => procedures.has(`sp_refresh_${name}`))) {
        await trx.raw(`exec oneroster12.sp_refresh_${table}`);
        const [{ open }] = mssqlRows(await trx.raw('select @@trancount as [open]'));
        if (open !== 1) throw new Error(`sp_refresh_${table} left @@TRANCOUNT at ${open}`);
      }
      const refreshed = mssqlRows(await trx.raw(
        'select table_name as name, status from oneroster12.refresh_history where history_id > ?', [last]
      ));
      const notRefreshed = refreshed.filter(row => row.status !== 'Success').map(row => `${row.name} ${row.status}`);
      if (refreshed.length === 0 || notRefreshed.length) {
        throw new Error(`refresh: ${notRefreshed.join(', ') || 'no tables refreshed'}`);
      }

      await checkCallers(trx, 'oneroster12', platform, failures, report);
      throw rollback;
    }).catch(error => {
      if (error !== rollback) throw error;
    });

    // The refresh history's identity values are used up, as any rolled-back insert's are
    const identities = changedSequences(identitiesBefore, await readIdentities(knex)).filter(name => !name.startsWith('oneroster12.'));
    if (identities.length) failures.push(`identities changed: ${identities.join(', ')}`);
    const sequences = changedSequences(sequencesBefore, await readMssqlSequences(knex));
    if (sequences.length) failures.push(`sequences changed: ${sequences.join(', ')}`);
    const [stateAfter] = mssqlRows(await knex.raw(MSSQL_STATE));
    if (stateAfter.foreignKeys !== stateBefore.foreignKeys || stateAfter.triggers !== stateBefore.triggers) {
      failures.push(`disabled foreign keys ${stateBefore.foreignKeys} -> ${stateAfter.foreignKeys}, triggers ${stateBefore.triggers} -> ${stateAfter.triggers} after rollback`);
    }
    const [students] = mssqlRows(await knex.raw(platform.fixtureStudents));
    if (students.n !== 0) failures.push(`${students.n} fixture student(s) left after rollback`);
    const projected = await mssqlFixtureRows(knex);
    if (projected !== 0) failures.push(`${projected} fixture row(s) left in the oneroster12 assessment tables after rollback`);
  } finally {
    await knex.destroy();
  }
  return { failures, report };
}

const ENGINES = {
  pgsql: { platforms: PLATFORMS, run: runPlatform },
  mssql: { platforms: MSSQL_PLATFORMS, run: runMssqlPlatform }
};

function parseArgs(argv) {
  const args = { engine: 'pgsql', platforms: PLATFORMS.map(platform => platform.name) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--platforms') args.platforms = argv[++i].split(',').map(name => name.trim()).filter(Boolean);
    else if (argv[i] === '--engine') args.engine = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!ENGINES[args.engine]) throw new Error('--engine takes pgsql or mssql');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = ENGINES[args.engine];
  let failed = 0;
  for (const platform of engine.platforms.filter(p => args.platforms.includes(p.name))) {
    if (!process.env[platform.env]) throw new Error(`Set ${platform.env}`);
    const { failures, report } = await engine.run(platform, process.env[platform.env]);
    console.log(`${platform.label}: ${report.callers} callers, ${report.checks - failures.length}/${report.checks} checks met; rolled back`);
    for (const failure of failures) console.log(`  ${failure}`);
    failed += failures.length;
  }
  console.log(failed === 0 ? '\nAUTH MATRIX: all callers as expected' : `\nAUTH MATRIX: ${failed} problem(s)`);
  process.exitCode = failed === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`assessment-auth-matrix: ${error.message}`);
    process.exit(2);
  });
}
