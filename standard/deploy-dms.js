#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * Deploy the OneRoster projections (schema oneroster12) into an Ed-Fi API v8 (DMS) data store,
 * on PostgreSQL (materialized views) or SQL Server (tables filled by sp_refresh_* procedures and a
 * SQL Server Agent job).
 *
 * 1. Reads dms."EffectiveSchema" and dms."SchemaComponent" to pick the artifact set
 *    (standard/<Ed-Fi data standard>/artifacts/dms-pgsql or dms-mssql) and the name map built for
 *    this exact effective schema and engine (see dms/build-name-map.js). Refuses to deploy when
 *    none matches.
 * 2. Resolves {{table:...}} placeholders to physical (possibly hash-shortened) table names.
 * 3. Checks that every edfi/dms/auth table or view the artifacts name exists.
 * 4. Applies the artifacts in one transaction, so a bad reference (a renamed column, say) changes
 *    nothing, and fills the projections (PostgreSQL: creating the views; SQL Server: running the
 *    refresh procedures). Rerunning replaces them.
 * 5. PostgreSQL: creates oneroster12.source_version(view) and oneroster12.refresh_state, which let
 *    the service skip refreshing a view whose sources haven't changed (src/services/viewRefresh.js).
 *    A view's sources are the resource tables it reads, a collection table counting as its
 *    resource; their versions are DMS's "ContentVersion" and, for deletes, the "ChangeVersion" of
 *    tracked_changes_<schema>.<resource>, both from dms."ChangeVersionSequence".
 *
 * DMS provisioning is create-only: a data store moves to another effective schema (a data standard,
 * extension or DMS upgrade) only in a new database, dropped and provisioned again, which removes
 * oneroster12. Rerun this script after every provision.
 *
 * Usage:
 *   node standard/deploy-dms.js --connection "host=...;port=5432;username=...;password=...;database=..."
 *   node standard/deploy-dms.js --db-type mssql --connection "Server=host,1433;Database=...;User Id=...;Password=..."
 *   Options:
 *     --db-type <type>        postgres (default) or mssql; DB_TYPE sets it too, as for the service.
 *     --check                 Validate only: resolve, check tables, then run the whole deployment
 *                             (create and fill the projections) in a transaction that is rolled
 *                             back. Nothing is kept, but it needs the privileges of a deployment,
 *                             and queries on existing oneroster12 objects wait until it finishes.
 *     --only orgs,users       Deploy these projections only (file names without .sql). On SQL
 *                             Server this skips the orchestration (sp_refresh_all and the Agent
 *                             job).
 *     --jobs-database <name>  PostgreSQL: also create this database for the pg-boss queue if it is
 *                             missing.
 *   The connection string can come from DMS_DATA_STORE_CONNECTION instead of --connection.
 *
 *   node standard/deploy-dms.js --from-cms [--data-store <id>] [--tenant <name>]
 *     Deploys to every data store the Configuration Service lists (or the one given), using
 *     CONFIG_SERVICE_URL, CONFIG_SERVICE_CLIENT_ID/_SECRET and CONFIG_SERVICE_ENCRYPTION_KEY, as the
 *     service does, including the secrets plugin (APP_SECRETS_MODULE, loaded as PLATFORM=dms). CMS
 *     connection strings name hosts on the DMS network, so run it there.
 *   Statements run without a timeout unless DB_REQUEST_TIMEOUT is set.
 *
 * SQL Server: the refresh job ("OneRoster 1.2 Refresh (<database>)", daily at 02:00 like the ODS
 * job) needs SQL Server Agent; the script warns when the Agent isn't running. The login needs
 * rights to create jobs in msdb.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import sql from 'mssql';
import { parseConnectionString } from '../src/config/multi-tenancy-config.js';
import { buildPostgresClientOptions } from '../src/config/db-connection.js';
import { buildRequestTimeoutOptions } from '../src/config/db-timeouts.js';
import { buildMssqlTlsOptions } from '../src/config/mssql-tls.js';
import { listArtifactFiles, listOrchestrationFiles, nameMapFileName, PLACEHOLDER_PATTERN } from './dms/build-name-map.js';
import { getDmsDataStoreSettings } from '../src/config/dms-config.js';
import { bootstrapAppSecretsIfNeeded } from '../src/config/app-secrets-bootstrap.js';
import { ConfigurationServiceClient } from '../src/platform/dms/configuration-service-client.js';
import { createConfigurationServiceDataStoreProvider } from '../src/platform/dms/data-store-providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_FILE = '00_setup.sql';
const SCHEMAS = ['edfi', 'dms', 'auth', 'tpdm'];
// Refresh order of the ODS master procedure (standard/<ds>/artifacts/mssql/orchestration)
const REFRESH_ORDER = ['academicsessions', 'orgs', 'courses', 'classes', 'demographics', 'users', 'enrollments'];

function quotePg(identifier) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteMssql(identifier) {
  return `[${identifier.replace(/]/g, ']]')}]`;
}

/**
 * What differs between the engines. Artifacts name DMS objects quoted the engine's way
 * (edfi."School" / edfi.[School]), which is how the reference check finds them.
 */
export const ENGINES = Object.freeze({
  postgres: Object.freeze({
    directory: 'dms-pgsql',
    dialect: 'pgsql',
    quote: quotePg,
    referencePattern: /\b(edfi|dms|auth|tpdm)\."([A-Za-z0-9_]+)"/g,
    projectionPattern: /create\s+materialized\s+view\s+(?:if\s+not\s+exists\s+)?oneroster12\.("?)([A-Za-z0-9_]+)\1/gi
  }),
  mssql: Object.freeze({
    directory: 'dms-mssql',
    dialect: 'mssql',
    quote: quoteMssql,
    referencePattern: /\b(edfi|dms|auth|tpdm)\.\[([A-Za-z0-9_]+)\]/g,
    projectionPattern: /create\s+table\s+oneroster12\.(\[?)([A-Za-z0-9_]+)\]?/gi
  })
});

function engineFor(dbType) {
  const engine = ENGINES[dbType];
  if (!engine) throw new Error(`Unknown database type '${dbType}' (postgres or mssql)`);
  return engine;
}

function parseArgs(argv) {
  const args = {
    connection: process.env.DMS_DATA_STORE_CONNECTION, dbType: process.env.DB_TYPE || 'postgres', check: false, only: null,
    jobsDatabase: null, fromCms: false, dataStore: null, tenant: null
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--connection': args.connection = argv[++i]; break;
      case '--db-type': args.dbType = argv[++i]; break;
      case '--check': args.check = true; break;
      case '--only': args.only = argv[++i].split(',').map(name => name.trim()).filter(Boolean); break;
      case '--jobs-database': args.jobsDatabase = argv[++i]; break;
      case '--from-cms': args.fromCms = true; break;
      case '--data-store': args.dataStore = argv[++i]; break;
      case '--tenant': args.tenant = argv[++i]; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.connection && !args.fromCms) throw new Error('Set --connection, DMS_DATA_STORE_CONNECTION or --from-cms');
  engineFor(args.dbType);
  if (args.jobsDatabase && args.dbType !== 'postgres') throw new Error('--jobs-database is for PostgreSQL (pg-boss) only');
  return args;
}

export function resolvePlaceholders(sqlText, nameMap, quote = quotePg) {
  const unresolved = new Set();
  const resolved = sqlText.replace(PLACEHOLDER_PATTERN, (match, project, resource, scope) => {
    const table = nameMap.tables[`${project}/${resource}/${scope}`];
    if (!table) {
      unresolved.add(match);
      return match;
    }
    return `${table.schema}.${quote(table.name)}`;
  });
  if (unresolved.size > 0) {
    throw new Error(`No name-map entry for ${[...unresolved].join(', ')}`);
  }
  return resolved;
}

export function findReferencedObjects(sqlText, pattern = ENGINES.postgres.referencePattern) {
  const objects = new Set();
  const code = sqlText.replace(/--[^\n]*/g, '');
  for (const [, schema, name] of code.matchAll(pattern)) {
    objects.add(`${schema}.${name}`);
  }
  return [...objects].sort();
}

/** The oneroster12 projections a file creates (materialized views; SQL Server: tables). */
export function findProjections(sqlText, pattern = ENGINES.postgres.projectionPattern) {
  return [...sqlText.matchAll(pattern)].map(match => match[2]);
}

/** Split a SQL Server script into the batches between GO lines. */
export function splitBatches(sqlText) {
  return sqlText.split(/^\s*GO\s*$/gim).map(batch => batch.trim()).filter(batch => batch.length > 0);
}

/**
 * One connection with what deploy() needs: rows(text) for queries, run(file) for an artifact,
 * and an explicit transaction. Queries take no parameters; values in them come from the data
 * store itself.
 */
async function openSession(dbType, connection) {
  const config = parseConnectionString(connection, dbType);
  if (dbType === 'postgres') {
    const client = new pg.Client({ ...buildPostgresClientOptions(config), ...buildRequestTimeoutOptions('postgres') });
    await client.connect();
    return {
      database: config.database,
      rows: async text => (await client.query(text)).rows,
      run: async text => { await client.query(text); },
      begin: () => client.query('begin'),
      commit: () => client.query('commit'),
      rollback: () => client.query('rollback'),
      end: () => client.end()
    };
  }

  const pool = await new sql.ConnectionPool({
    server: config.server,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    options: { ...buildMssqlTlsOptions(config), enableArithAbort: true },
    connectionTimeout: 30000,
    ...buildRequestTimeoutOptions('mssql'),
    pool: { max: 1, min: 0 }
  }).connect();
  let transaction = null;
  const request = () => new sql.Request(transaction || pool);
  return {
    database: config.database,
    rows: async text => (await request().query(text)).recordset || [],
    run: async text => {
      for (const batch of splitBatches(text)) await request().batch(batch);
    },
    begin: async () => { transaction = new sql.Transaction(pool); await transaction.begin(); },
    commit: async () => { await transaction.commit(); transaction = null; },
    // A refresh procedure that fails rolls the whole transaction back itself
    rollback: async () => {
      try { await transaction?.rollback(); } catch { /* already rolled back */ }
      transaction = null;
    },
    end: () => pool.close()
  };
}

const TARGET_QUERIES = {
  postgres: {
    effective: 'select "EffectiveSchemaHash" as hash from dms."EffectiveSchema"',
    components: hash => `select "ProjectName" as project, "ProjectVersion" as version from dms."SchemaComponent" where "EffectiveSchemaHash" = '${hash}'`,
    tables: `select table_schema || '.' || table_name as name from information_schema.tables where table_schema in (${SCHEMAS.map(s => `'${s}'`).join(', ')})`,
    count: name => `select count(*)::int as n from oneroster12.${quotePg(name)}`
  },
  mssql: {
    effective: 'select EffectiveSchemaHash as hash from dms.EffectiveSchema',
    components: hash => `select ProjectName as project, ProjectVersion as version from dms.SchemaComponent where EffectiveSchemaHash = N'${hash}'`,
    tables: `select TABLE_SCHEMA + '.' + TABLE_NAME as name from INFORMATION_SCHEMA.TABLES where TABLE_SCHEMA in (${SCHEMAS.map(s => `'${s}'`).join(', ')})`,
    count: name => `select count(*) as n from oneroster12.${quoteMssql(name)}`
  }
};

async function readTargetSchema(session, dbType) {
  const queries = TARGET_QUERIES[dbType];
  const effective = await session.rows(queries.effective);
  if (effective.length !== 1) {
    throw new Error('dms."EffectiveSchema" has no single row: is this a provisioned DMS data store?');
  }
  const hash = effective[0].hash;
  // The hash is hex from the data store; checked before it goes into the query text
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`Unexpected effective schema hash '${hash}'`);
  const components = await session.rows(queries.components(hash));
  const core = components.find(row => row.project === 'Ed-Fi');
  if (!core) {
    throw new Error('dms."SchemaComponent" lists no Ed-Fi project');
  }
  return { hash, dataStandard: core.version, components };
}

function loadArtifacts(target, engine, only) {
  const artifactsDir = path.join(__dirname, target.dataStandard, 'artifacts', engine.directory);
  if (!fs.existsSync(artifactsDir)) {
    throw new Error(`No DMS artifacts for Ed-Fi Data Standard ${target.dataStandard} (${artifactsDir})`);
  }

  const nameMapFile = path.join(artifactsDir, nameMapFileName(target.hash));
  if (!fs.existsSync(nameMapFile)) {
    throw new Error(
      `No name map for effective schema ${target.hash} in ${artifactsDir}. ` +
      'Build one from this data store\'s relational-model manifest with standard/dms/build-name-map.js.'
    );
  }
  const nameMap = JSON.parse(fs.readFileSync(nameMapFile, 'utf8'));
  if (nameMap.effectiveSchemaHash !== target.hash || nameMap.dialect !== engine.dialect) {
    throw new Error(`${nameMapFile} does not match effective schema ${target.hash} (${engine.dialect})`);
  }

  let files = listArtifactFiles(artifactsDir);
  if (only) {
    const wanted = new Set([SETUP_FILE, ...only.map(name => `${name}.sql`)]);
    const unknown = only.filter(name => !files.some(file => path.basename(file) === `${name}.sql`));
    if (unknown.length > 0) throw new Error(`Unknown projection(s): ${unknown.join(', ')}`);
    files = files.filter(file => wanted.has(path.basename(file)));
  } else {
    files = [...files, ...listOrchestrationFiles(artifactsDir)];
  }

  return files.map(file => ({
    file: path.relative(artifactsDir, file),
    sql: resolvePlaceholders(fs.readFileSync(file, 'utf8'), nameMap, engine.quote)
  }));
}

async function checkReferencedObjects(session, dbType, engine, artifacts) {
  const referenced = [...new Set(artifacts.flatMap(({ sql: text }) => findReferencedObjects(text, engine.referencePattern)))];
  const existing = new Set((await session.rows(TARGET_QUERIES[dbType].tables)).map(row => row.name));
  const missing = referenced.filter(name => !existing.has(name));
  if (missing.length > 0) {
    throw new Error(`Referenced objects missing from the data store: ${missing.join(', ')}`);
  }
  return referenced.length;
}

/**
 * The versioned resource tables behind the objects a projection reads. A table with a
 * "ContentVersion" column is a resource; a collection table (no "ContentVersion") stands for the
 * resource whose name it starts with and whose "<Resource>_DocumentId" it carries, because DMS
 * restamps the resource's version when a collection row changes. tracked_changes_<schema> tables
 * that exist for those resources record deletes (dms."Descriptor" deletes go to
 * tracked_changes_edfi).
 *
 * @param {string[]} referenced - "schema.Table" names, as findReferencedObjects returns them
 * @param {{versioned: Set<string>, columns: Map<string, Set<string>>, tracked: Set<string>}} catalog
 * @returns {{resources: string[], deletes: string[]}}
 */
export function resolveSourceTables(referenced, catalog) {
  const resources = new Set();
  for (const name of referenced) {
    const [schema, table] = name.split('.');
    if (schema === 'auth') continue;
    if (catalog.versioned.has(name)) {
      resources.add(name);
      continue;
    }
    const columns = catalog.columns.get(name) || new Set();
    const owner = [...catalog.versioned]
      .filter(candidate => {
        const [candidateSchema, resource] = candidate.split('.');
        return candidateSchema === schema && table.startsWith(resource) && columns.has(`${resource}_DocumentId`);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!owner) {
      throw new Error(`${name} is neither a versioned resource nor a collection of one; can't track its changes`);
    }
    resources.add(owner);
  }
  const deletes = [...resources]
    .map(name => {
      const [schema, table] = name.split('.');
      return `tracked_changes_${schema === 'dms' ? 'edfi' : schema}.${table}`;
    })
    .filter(name => catalog.tracked.has(name));
  return { resources: [...resources].sort(), deletes: deletes.sort() };
}

/**
 * PostgreSQL: oneroster12.source_version(view) and oneroster12.refresh_state. The redeployed
 * views lose their recorded state, so the next scheduled refresh rebuilds them once.
 *
 * @param {Object<string, {resources: string[], deletes: string[]}>} sourcesByView - every projection
 *   in the artifact set, deployed or not, so --only keeps the others tracked
 * @param {string[]} deployedViews
 */
export function buildRefreshTrackingSql(sourcesByView, deployedViews) {
  const quoteName = name => {
    const [schema, table] = name.split('.');
    return `${schema}.${quotePg(table)}`;
  };
  const cases = Object.entries(sourcesByView).sort(([a], [b]) => a.localeCompare(b)).map(([view, { resources, deletes }]) => {
    const terms = [
      ...resources.map(name => `(select max("ContentVersion") from ${quoteName(name)})`),
      ...deletes.map(name => `(select max("ChangeVersion") from ${quoteName(name)})`)
    ];
    return `    when '${view}' then greatest(0,\n      ${terms.join(',\n      ')})`;
  });
  const deployed = deployedViews.map(view => `'${view}'`).join(', ');
  return `-- Generated by standard/deploy-dms.js: change tracking for the scheduled refresh.
create table if not exists oneroster12.refresh_state (
    view_name text primary key,
    source_version bigint not null,
    -- false when another write was in flight as the version was read: that write may commit
    -- with a lower version, so the next run refreshes regardless
    complete boolean not null,
    refreshed_at timestamptz not null default now()
);
create or replace function oneroster12.source_version(p_view text) returns bigint
language sql stable as $fn$
  select case p_view
${cases.join('\n')}
  end
$fn$;
${deployed ? `delete from oneroster12.refresh_state where view_name in (${deployed});` : ''}
`;
}

async function readTrackingCatalog(session) {
  const columns = new Map();
  const versioned = new Set();
  const rows = await session.rows(`select table_schema || '.' || table_name as name, column_name as col
      from information_schema.columns
     where table_schema in (${SCHEMAS.filter(s => s !== 'auth').map(s => `'${s}'`).join(', ')})
       and (column_name = 'ContentVersion' or column_name like '%\\_DocumentId')`);
  for (const { name, col } of rows) {
    if (col === 'ContentVersion') versioned.add(name);
    else (columns.get(name) || columns.set(name, new Set()).get(name)).add(col);
  }
  const tracked = new Set((await session.rows(`select table_schema || '.' || table_name as name
      from information_schema.tables where table_schema like 'tracked\\_changes\\_%'`)).map(row => row.name));
  return { versioned, columns, tracked };
}

/** PostgreSQL: the generated change-tracking artifact for this artifact set. */
async function refreshTrackingArtifact(session, engine, allArtifacts, deployedArtifacts) {
  const catalog = await readTrackingCatalog(session);
  const sourcesByView = {};
  for (const { sql: text } of allArtifacts) {
    const views = findProjections(text, engine.projectionPattern);
    if (views.length === 0) continue;
    const sources = resolveSourceTables(findReferencedObjects(text, engine.referencePattern), catalog);
    for (const view of views) sourcesByView[view] = sources;
  }
  const deployedViews = deployedArtifacts.flatMap(({ sql: text }) => findProjections(text, engine.projectionPattern));
  return { file: '(generated) refresh tracking', sql: buildRefreshTrackingSql(sourcesByView, deployedViews), sourcesByView };
}

/**
 * SQL Server: fill the tables with their sp_refresh_<table> procedures, in sp_refresh_all's order.
 * They run inside the deployment's transaction, so a procedure that fails (a renamed column, say)
 * undoes the deployment; sp_refresh_all itself refuses an open transaction. A post-refresh hook
 * runs with the next sp_refresh_all, as after the ODS deploy's refresh.
 */
async function refreshMssql(session, projections) {
  const started = Date.now();
  for (const name of REFRESH_ORDER.filter(n => projections.includes(n))) {
    await session.run(`exec oneroster12.${quoteMssql(`sp_refresh_${name}`)}`);
  }
  return Date.now() - started;
}

async function applyArtifacts(session, dbType, engine, artifacts, { commit }) {
  const timings = [];
  const projections = artifacts.flatMap(({ sql: text }) => findProjections(text, engine.projectionPattern))
    .filter(name => !name.startsWith('refresh_'));
  await session.begin();
  try {
    for (const { file, sql: text } of artifacts) {
      const started = Date.now();
      try {
        await session.run(text);
      } catch (error) {
        throw new Error(`${file}: ${error.message}`);
      }
      timings.push({ file, ms: Date.now() - started });
    }
    if (dbType === 'mssql') {
      timings.push({ file: 'sp_refresh_*', ms: await refreshMssql(session, projections) });
    }

    const counts = {};
    for (const name of projections) {
      counts[name] = Number((await session.rows(TARGET_QUERIES[dbType].count(name)))[0].n);
    }

    await (commit ? session.commit() : session.rollback());
    return { timings, counts };
  } catch (error) {
    await session.rollback();
    throw error;
  }
}

/** SQL Server: whether SQL Server Agent runs, so the refresh job will. Null when it can't tell. */
async function mssqlAgentRunning(session) {
  try {
    const rows = await session.rows("select count(*) as n from sys.dm_exec_sessions where program_name like N'SQLAgent%'");
    return Number(rows[0].n) > 0;
  } catch {
    return null;
  }
}

async function ensureJobsDatabase(session, name) {
  const rows = await session.rows(`select 1 from pg_database where datname = '${name.replace(/'/g, "''")}'`);
  if (rows.length > 0) return false;
  await session.run(`create database ${quotePg(name)}`);
  return true;
}

/** Connection strings for the data stores the Configuration Service lists. */
async function dataStoreConnections(args) {
  // The client secret and encryption key may come from the service's secrets plugin
  await bootstrapAppSecretsIfNeeded({ dms: true });
  const settings = getDmsDataStoreSettings();
  const provider = createConfigurationServiceDataStoreProvider({
    client: new ConfigurationServiceClient({
      baseUrl: settings.configServiceUrl, clientId: settings.clientId, clientSecret: settings.clientSecret, scope: settings.scope,
      timeoutMs: settings.timeoutMs
    }),
    encryptionKey: settings.encryptionKey,
    allowLegacy: settings.allowLegacy
  });
  const dataStores = (await provider.listDataStores(args.tenant))
    .filter(ds => !args.dataStore || ds.id === String(args.dataStore));
  if (dataStores.length === 0) throw new Error('The Configuration Service lists no matching data store');
  return Promise.all(dataStores.map(async ds => ({
    label: `data store ${ds.id} (${ds.name})`,
    connection: await provider.resolveConnectionString({ tenantId: args.tenant, dataStoreId: ds.id })
  })));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // A deploy builds every projection from scratch, which can exceed the API's per-query timeout.
  process.env.DB_REQUEST_TIMEOUT ??= '0';

  const targets = args.fromCms ? await dataStoreConnections(args) : [{ label: null, connection: args.connection }];
  for (const target of targets) {
    if (target.label) console.log(`\n== ${target.label}`);
    await deploy(args, target.connection);
  }
}

async function deploy(args, connection) {
  const engine = engineFor(args.dbType);
  const session = await openSession(args.dbType, connection);

  try {
    const target = await readTargetSchema(session, args.dbType);
    console.log(`Data store ${session.database} (${args.dbType}): Ed-Fi ${target.dataStandard} ` +
      `(${target.components.map(c => `${c.project} ${c.version}`).join(', ')}), effective schema ${target.hash.slice(0, 12)}…`);

    const artifacts = loadArtifacts(target, engine, args.only);
    const objectCount = await checkReferencedObjects(session, args.dbType, engine, artifacts);
    console.log(`${artifacts.length} artifact file(s); ${objectCount} referenced edfi/dms/auth objects exist`);
    if (args.dbType === 'postgres') {
      const tracking = await refreshTrackingArtifact(session, engine, args.only ? loadArtifacts(target, engine, null) : artifacts, artifacts);
      artifacts.push(tracking);
      const tracked = Object.values(tracking.sourcesByView);
      console.log(`Refresh tracking: ${tracked.length} views, ${new Set(tracked.flatMap(t => t.resources)).size} source resources`);
    }

    const { timings, counts } = await applyArtifacts(session, args.dbType, engine, artifacts, { commit: !args.check });
    for (const { file, ms } of timings) console.log(`  ${file.padEnd(36)} ${String(ms).padStart(6)} ms`);
    for (const [view, n] of Object.entries(counts)) console.log(`  oneroster12.${view.padEnd(18)} ${n} rows`);
    console.log(args.check ? 'Check passed; nothing was changed.' : 'Deployed.');

    if (args.dbType === 'mssql' && !args.check && !args.only && await mssqlAgentRunning(session) === false) {
      console.log('Warning: SQL Server Agent is not running, so the refresh job will not run. ' +
        'Enable it (Docker: MSSQL_AGENT_ENABLED=true, or mssql-conf set sqlagent.enabled true) or run ' +
        'exec oneroster12.sp_refresh_all on a schedule of your own.');
    }

    if (args.jobsDatabase && !args.check) {
      const created = await ensureJobsDatabase(session, args.jobsDatabase);
      console.log(`pg-boss database ${args.jobsDatabase}: ${created ? 'created' : 'exists'}`);
    }
  } finally {
    await session.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`deploy-dms: ${error.message}`);
    process.exit(1);
  });
}
