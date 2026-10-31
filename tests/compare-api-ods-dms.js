// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

/**
 * API-level parity between the OneRoster service on the ODS/API and on Ed-Fi API v8 (DMS), both
 * loaded with the same data: `node tests/compare-api.js ods-vs-dms`.
 *
 * For each pair of equivalent clients (LEA, School) it pages every collection on both services,
 * fetches a sample of single items, and compares the bodies item by item, ignoring
 * dateLastModified. Arrays holding the same elements in another order are reported separately.
 * A sourcedId that appears more than once in a collection, on either side, is a difference.
 * ODS items tied to the excluded education organizations (default 5,6,7: the TPDM sample schools)
 * are dropped first. Also compares the status and body of a few error responses.
 *
 * Environment (tokens are requested once per client per run):
 *   ODS_ONEROSTER_URL   e.g. https://localhost/oneroster-api
 *   ODS_TOKEN_URL       e.g. https://localhost/api/oauth/token
 *   ODS_LEA_KEY / ODS_LEA_SECRET, ODS_SCHOOL_KEY / ODS_SCHOOL_SECRET
 *   DMS_ONEROSTER_URL   e.g. http://localhost:3200
 *   DMS_TOKEN_URL       e.g. http://localhost:8080/oauth/token
 *   DMS_LEA_KEY / DMS_LEA_SECRET, DMS_SCHOOL_KEY / DMS_SCHOOL_SECRET
 *   DMS_CORE_KEY / DMS_CORE_SECRET (optional: a client on a roster-core-only claim set)
 * Options: --exclude-edorgs 5,6,7  --samples 3  --page-size 500
 *   --ods-env <file>  Read the ODS values from an ODS stack env file (stack/pgsql/.env.5.2.0):
 *                     LEA_KEY, LEA_SECRET, SCHOOL_KEY, SCHOOL_SECRET, and the URLs from BASE_URL,
 *                     ONEROSTER_API_VIRTUAL_NAME and ODS_API_VIRTUAL_NAME.
 *   --dms-env <file>  Read the DMS_* values from stack/dms/.env.dms-clients
 *                     (written by stack/setup-dms-clients.ps1).
 *   Variables already set in the environment take precedence over both files.
 *   --assessment-rostering  Also compare the assessment rostering collections (both services need
 *                     ASSESSMENT_ROSTERING_ENABLED=true). dms-vs-recording turns it on by itself for a
 *                     recording that has them.
 *   --known <file>    Differences already explained (JSON, see dms-parity-known-differences.json):
 *                     they are listed but don't fail the run. Exit code 1 means an unexplained
 *                     difference.
 *
 * DMS against DMS (e.g. PostgreSQL against SQL Server). The two DMS stacks share container names,
 * so they can't run together: record one, then compare the other with the recording.
 *   node tests/compare-api.js dms-record --dms-env <file> --out <recording.json> [--name PostgreSQL]
 *     Writes every response the comparison uses (no credentials) to the file, mode 600.
 *   node tests/compare-api.js dms-vs-recording --dms-env <file> --recording <recording.json> [--name "SQL Server"] [--known <file>]
 *     Fetches the same collections, single items and error cases from the running service and
 *     compares them with the recording, as ods-vs-dms does (no excluded education organizations).
 *   The DMS_* settings work as above; the recording's roster-core case needs DMS_CORE_KEY.
 */

import crypto from 'crypto';
import fs from 'fs';
import dotenv from 'dotenv';

const ROSTER_PATH = 'ims/oneroster/rostering/v1p2';
const SCOPE = 'https://purl.imsglobal.org/spec/or/v1p2/scope/';
const ODS_SCOPES = ['roster.readonly', 'roster-core.readonly', 'roster-demographics.readonly'].map(s => SCOPE + s).join(' ');
const COLLECTIONS = {
  academicSessions: 'academicSessions', gradingPeriods: 'academicSessions', terms: 'academicSessions',
  classes: 'classes', courses: 'courses', demographics: 'demographics', enrollments: 'enrollments',
  orgs: 'orgs', schools: 'orgs', users: 'users', students: 'users', teachers: 'users'
};
// Assessment rostering (--assessment-rostering): name -> [path from the service root, wrapper]
const ASSESSMENT_BASE = '/ims/oneroster/assessmentRostering/v1p0';
const ASSESSMENT_COLLECTIONS = {
  assessments: [`${ASSESSMENT_BASE}/assessments`, 'assessments'],
  assessmentOfferings: [`${ASSESSMENT_BASE}/assessmentOfferings`, 'assessmentOfferings'],
  assessmentEnrollments: [`${ASSESSMENT_BASE}/assessmentEnrollments`, 'assessmentEnrollments']
};

const CLIENTS = ['lea', 'school'];
const SIDE_NAMES = ['ODS', 'DMS'];
const ERROR_CASES = [
  ['no token', 'orgs', null],
  ['malformed token', 'orgs', 'not.a.token'],
  ['bad limit', 'orgs?limit=abc', 'lea'],
  ['unknown id', `orgs/${'0'.repeat(32)}`, 'lea'],
  ['unknown path', 'nothing', 'lea'],
  ['bad filter field', `orgs?filter=${encodeURIComponent("password='x'")}`, 'lea']
];
// roster-core only: demographics must be refused, the same way on both sides
const CORE_CASE = 'core scope on demographics';
const RECORDING_FORMAT = 'oneroster-api-recording/1';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const md5 = text => crypto.createHash('md5').update(text).digest('hex');

function parseArgs(argv) {
  const args = {
    excluded: ['5', '6', '7'], samples: 3, pageSize: 500, odsEnv: null, dmsEnv: null, known: null, out: null, recording: null, name: null,
    assessment: false
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exclude-edorgs') args.excluded = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--samples') args.samples = Number(argv[++i]);
    else if (argv[i] === '--page-size') args.pageSize = Number(argv[++i]);
    else if (argv[i] === '--ods-env') args.odsEnv = argv[++i];
    else if (argv[i] === '--dms-env') args.dmsEnv = argv[++i];
    else if (argv[i] === '--known') args.known = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--recording') args.recording = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--assessment-rostering') args.assessment = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

const joinPath = (base, name) => `${base.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`;

/**
 * The ODS_* and DMS_* settings from the stack env files. Keys already in `env` are kept, so an
 * exported variable overrides a file.
 */
export function settingsFromEnvFiles({ odsEnvText, dmsEnvText }, env = process.env) {
  const settings = {};
  if (odsEnvText) {
    const ods = dotenv.parse(odsEnvText);
    for (const name of ['LEA_KEY', 'LEA_SECRET', 'SCHOOL_KEY', 'SCHOOL_SECRET']) {
      if (ods[name]) settings[`ODS_${name}`] = ods[name];
    }
    if (ods.BASE_URL && ods.ONEROSTER_API_VIRTUAL_NAME) {
      settings.ODS_ONEROSTER_URL = joinPath(ods.BASE_URL, ods.ONEROSTER_API_VIRTUAL_NAME);
    }
    if (ods.BASE_URL && ods.ODS_API_VIRTUAL_NAME) {
      settings.ODS_TOKEN_URL = joinPath(joinPath(ods.BASE_URL, ods.ODS_API_VIRTUAL_NAME), 'oauth/token');
    }
  }
  if (dmsEnvText) {
    for (const [name, value] of Object.entries(dotenv.parse(dmsEnvText))) {
      if (name.startsWith('DMS_')) settings[name] = value;
    }
  }
  return Object.fromEntries(Object.entries(settings).filter(([name]) => !env[name]));
}

/**
 * Split differences into those a known-differences entry explains and the rest. An entry matches on
 * label and kind, and on sourcedId when it lists sourcedIds.
 */
export function partitionDifferences(diffs, known = []) {
  const explained = [];
  const unexplained = [];
  for (const diff of diffs) {
    const entry = known.find(k => k.label === diff.label && k.kind === diff.kind &&
      (!k.sourcedIds || k.sourcedIds.includes(diff.sourcedId)));
    (entry ? explained : unexplained).push(entry ? { ...diff, reason: entry.reason } : diff);
  }
  return { explained, unexplained };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

async function token(url, id, secret, scope) {
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) body.set('scope', scope);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`Token request to ${url} returned ${res.status}`);
  return (await res.json()).access_token;
}

/** GET, waiting out the rate limiter when it answers 429. */
async function get(url, bearer) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
    if (res.status === 429) {
      const wait = Number(res.headers.get('ratelimit-reset') || res.headers.get('retry-after') || 30);
      await sleep((wait + 1) * 1000);
      continue;
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  }
  throw new Error(`Still rate limited: ${url}`);
}

function canonical(value, sortArrays) {
  const walk = v => {
    if (Array.isArray(v)) {
      const items = v.map(walk);
      return sortArrays ? items.map(i => JSON.stringify(i)).sort().map(t => JSON.parse(t)) : items;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, walk(v[k])]));
    return v;
  };
  return JSON.stringify(walk(value));
}

function withoutTimestamp(item) {
  if (!item || typeof item !== 'object') return item;
  const { dateLastModified, ...rest } = item;
  return rest;
}

/** sourcedIds that appear more than once in a collection, with how often. */
function repeatedIds(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.sourcedId, (counts.get(item.sourcedId) || 0) + 1);
  return [...counts].filter(([, count]) => count > 1);
}

/**
 * Compare one collection item by item. A sourcedId that appears more than once on either side is a
 * difference of its own ('duplicate on ODS' / 'duplicate on DMS'); matching by sourcedId alone
 * would hide it. `names` labels the two sides in the difference kinds.
 * @returns {{ row: Object, diffs: Object[] }}
 */
export function compareCollection(label, odsItems, dmsItems, names = SIDE_NAMES) {
  const [nameA, nameB] = names;
  const diffs = [];
  const odsById = new Map(odsItems.map(item => [item.sourcedId, withoutTimestamp(item)]));
  const dmsById = new Map(dmsItems.map(item => [item.sourcedId, withoutTimestamp(item)]));
  const row = { label, ods: odsItems.length, dms: dmsItems.length, identical: 0, orderOnly: 0, differ: 0, onlyOds: 0, onlyDms: 0, duplicates: 0 };
  for (const [side, items] of [[nameA, odsItems], [nameB, dmsItems]]) {
    for (const [id, count] of repeatedIds(items)) {
      row.duplicates++;
      diffs.push({ label, sourcedId: id, kind: `duplicate on ${side}`, count });
    }
  }
  for (const [id, item] of odsById) {
    if (!dmsById.has(id)) { row.onlyOds++; diffs.push({ label, sourcedId: id, kind: `only ${nameA}` }); continue; }
    const other = dmsById.get(id);
    if (canonical(item, false) === canonical(other, false)) row.identical++;
    else if (canonical(item, true) === canonical(other, true)) row.orderOnly++;
    else { row.differ++; diffs.push({ label, sourcedId: id, kind: 'differs', [nameA.toLowerCase()]: item, [nameB.toLowerCase()]: other }); }
  }
  for (const id of dmsById.keys()) {
    if (!odsById.has(id)) { row.onlyDms++; diffs.push({ label, sourcedId: id, kind: `only ${nameB}` }); }
  }
  // Same items, so the order of the collection itself should match too (stable paging, #133)
  row.sameOrder = canonical([...odsById.keys()].filter(id => dmsById.has(id)), false) ===
    canonical([...dmsById.keys()].filter(id => odsById.has(id)), false);
  return { row, diffs };
}

/** Whether an ODS item belongs to an excluded education organization. */
function isExcluded(item, excludedOrgs, excludedUsers) {
  if (excludedOrgs.has(item.sourcedId) || excludedUsers.has(item.sourcedId)) return true;
  const refs = [item.org, item.school, ...(item.orgs || [])].filter(Boolean).map(ref => ref.sourcedId);
  return refs.length > 0 && refs.every(id => excludedOrgs.has(id));
}

/**
 * A OneRoster service over HTTP. `clients` maps a client name to { key, secret, scope }; each gets
 * one token, requested here. get(path, client) takes a client name, a raw bearer value or null.
 */
async function liveService(url, tokenUrl, clients) {
  const base = `${url.replace(/\/+$/, '')}/${ROSTER_PATH}`;
  const tokens = {};
  for (const [name, { key, secret, scope }] of Object.entries(clients)) {
    tokens[name] = await token(tokenUrl, key, secret, scope);
  }
  const service = {
    requests: 0,
    // a path starting with '/' is from the service root, any other from the rostering base
    get: async (path, client) => {
      service.requests++;
      const target = path.startsWith('/') ? `${url.replace(/\/+$/, '')}${path}` : `${base}/${path}`;
      return get(target, client !== null && client in tokens ? tokens[client] : client);
    }
  };
  return service;
}

/**
 * Every response the comparison needs from one service: each collection, paged in full, for the
 * LEA and School clients; single items (the first `samples` of each collection, or `sampleIds`
 * when given, so both sides fetch the same ids); the error cases; and, when `core` is set,
 * /demographics for the roster-core client. `assessment` adds the assessment rostering collections.
 */
export async function collectResponses(service, { pageSize = 500, samples = 3, sampleIds = null, core = false, assessment = false } = {}) {
  const responses = { collections: {}, singles: {}, errors: {} };
  const collections = [
    ...Object.entries(COLLECTIONS).map(([name, wrapper]) => [name, name, wrapper]),
    ...(assessment ? Object.entries(ASSESSMENT_COLLECTIONS).map(([name, [path, wrapper]]) => [name, path, wrapper]) : [])
  ];
  for (const client of CLIENTS) {
    for (const [collection, path, wrapper] of collections) {
      const label = `${client} ${collection}`;
      const items = [];
      for (let offset = 0; ; offset += pageSize) {
        const res = await service.get(`${path}?limit=${pageSize}&offset=${offset}`, client);
        if (res.status !== 200) throw new Error(`${label}: HTTP ${res.status}`);
        const page = res.body[wrapper] || [];
        items.push(...page);
        if (page.length < pageSize) break;
      }
      responses.collections[label] = items;
      responses.singles[label] = {};
      const ids = sampleIds ? Object.keys(sampleIds[label] || {}) : items.slice(0, samples).map(item => item.sourcedId);
      for (const id of ids) responses.singles[label][id] = await service.get(`${path}/${id}`, client);
    }
  }
  for (const [label, path, client] of ERROR_CASES) responses.errors[label] = await service.get(path, client);
  if (core) responses.errors[CORE_CASE] = await service.get('demographics', 'core');
  return responses;
}

/**
 * Compare the responses of two services. Items of side A tied to `excludedEdOrgs` (and those
 * users' demographics) are dropped first.
 * @returns {{ summary: Object[], diffs: Object[] }}
 */
export function compareResponses(a, b, { excludedEdOrgs = [], names = SIDE_NAMES } = {}) {
  const [nameA, nameB] = names;
  const excludedOrgs = new Set(excludedEdOrgs.map(md5));
  const excludedUsers = new Set();
  for (const client of CLIENTS) {
    (a.collections[`${client} users`] || []).filter(item => isExcluded(item, excludedOrgs, excludedUsers))
      .forEach(item => excludedUsers.add(item.sourcedId));
  }

  const summary = [];
  const diffs = [];
  for (const label of Object.keys(a.collections).filter(label => !(label in b.collections))) {
    diffs.push({ label, kind: `collection only in the ${nameA} responses` });
  }
  for (const label of Object.keys(b.collections)) {
    if (!a.collections[label]) throw new Error(`${label}: not in the ${nameA} responses`);
    const kept = a.collections[label].filter(item => !isExcluded(item, excludedOrgs, excludedUsers));
    const result = compareCollection(label, kept, b.collections[label], names);
    summary.push(result.row);
    diffs.push(...result.diffs);

    const strip = res => res && { status: res.status, body: Object.fromEntries(Object.entries(res.body || {}).map(([k, v]) => [k, withoutTimestamp(v)])) };
    const ids = new Set([...Object.keys(a.singles[label] || {}), ...Object.keys(b.singles[label] || {})]);
    for (const id of ids) {
      const [x, y] = [a.singles[label]?.[id], b.singles[label]?.[id]];
      if (canonical(strip(x) ?? null, true) !== canonical(strip(y) ?? null, true)) {
        diffs.push({ label: `${label}/:id`, sourcedId: id, kind: 'single item differs', [nameA.toLowerCase()]: x, [nameB.toLowerCase()]: y });
      }
    }
  }

  for (const label of new Set([...Object.keys(a.errors), ...Object.keys(b.errors)])) {
    const [x, y] = [a.errors[label], b.errors[label]];
    const refused = label !== CORE_CASE || x?.status === 403;
    if (!refused || canonical(x ?? null, false) !== canonical(y ?? null, false)) {
      diffs.push({ label: `error: ${label}`, kind: 'error response differs', [nameA.toLowerCase()]: x, [nameB.toLowerCase()]: y });
    }
  }
  return { summary, diffs };
}

/** Print the summary table and the differences; returns the exit code (0 = nothing unexplained). */
function report({ summary, diffs }, { names = SIDE_NAMES, known = [], requests }) {
  const [nameA, nameB] = names.map(name => name.slice(0, 6));
  console.log(`${'collection'.padEnd(22)} ${nameA.padStart(6)} ${nameB.padStart(6)} ${'same'.padStart(6)} order-only differ ${`only${nameA}`.padStart(10)} ${`only${nameB}`.padStart(10)} dupes sameOrder`);
  for (const r of summary) {
    console.log(`${r.label.padEnd(22)} ${String(r.ods).padStart(6)} ${String(r.dms).padStart(6)} ${String(r.identical).padStart(6)} ${String(r.orderOnly).padStart(10)} ${String(r.differ).padStart(6)} ${String(r.onlyOds).padStart(10)} ${String(r.onlyDms).padStart(10)} ${String(r.duplicates).padStart(5)} ${r.sameOrder}`);
  }
  const { explained, unexplained } = partitionDifferences(diffs, known);
  const reasons = new Map();
  for (const d of explained) reasons.set(d.reason, (reasons.get(d.reason) || 0) + 1);
  for (const [reason, count] of reasons) console.log(`known (${count}): ${reason}`);
  for (const d of unexplained.slice(0, 15)) console.log(JSON.stringify(d).slice(0, 400));
  const orderMismatches = summary.filter(r => !r.sameOrder).length;
  console.log(`\n${requests} requests; ${diffs.length} difference(s), ${explained.length} known, ` +
    `${unexplained.length} unexplained; ${orderMismatches} collection(s) in a different order`);
  return unexplained.length === 0 && orderMismatches === 0 ? 0 : 1;
}

function loadEnvFiles(args) {
  Object.assign(process.env, settingsFromEnvFiles({
    odsEnvText: args.odsEnv && fs.readFileSync(args.odsEnv, 'utf8'),
    dmsEnvText: args.dmsEnv && fs.readFileSync(args.dmsEnv, 'utf8')
  }));
}

function loadKnown(args) {
  return args.known ? JSON.parse(fs.readFileSync(args.known, 'utf8')).differences : [];
}

/** The DMS-backed service from the DMS_* settings; the core client only when DMS_CORE_KEY is set. */
function dmsService() {
  const clients = {
    lea: { key: requireEnv('DMS_LEA_KEY'), secret: requireEnv('DMS_LEA_SECRET') },
    school: { key: requireEnv('DMS_SCHOOL_KEY'), secret: requireEnv('DMS_SCHOOL_SECRET') }
  };
  if (process.env.DMS_CORE_KEY) clients.core = { key: process.env.DMS_CORE_KEY, secret: requireEnv('DMS_CORE_SECRET') };
  return liveService(requireEnv('DMS_ONEROSTER_URL'), requireEnv('DMS_TOKEN_URL'), clients);
}

export async function runOdsVsDms(argv) {
  const args = parseArgs(argv);
  loadEnvFiles(args);
  const core = Boolean(process.env.DMS_CORE_KEY);
  const ods = await liveService(requireEnv('ODS_ONEROSTER_URL'), requireEnv('ODS_TOKEN_URL'), {
    lea: { key: requireEnv('ODS_LEA_KEY'), secret: requireEnv('ODS_LEA_SECRET'), scope: ODS_SCOPES },
    school: { key: requireEnv('ODS_SCHOOL_KEY'), secret: requireEnv('ODS_SCHOOL_SECRET'), scope: ODS_SCOPES },
    ...(core && { core: { key: requireEnv('ODS_LEA_KEY'), secret: requireEnv('ODS_LEA_SECRET'), scope: `${SCOPE}roster-core.readonly` } })
  });
  const dms = await dmsService();

  // DMS first: the single items are sampled from DMS, which has no excluded education organizations
  const options = { pageSize: args.pageSize, core, assessment: args.assessment };
  const dmsResponses = await collectResponses(dms, { ...options, samples: args.samples });
  const odsResponses = await collectResponses(ods, { ...options, sampleIds: dmsResponses.singles });
  return report(compareResponses(odsResponses, dmsResponses, { excludedEdOrgs: args.excluded }),
    { known: loadKnown(args), requests: ods.requests + dms.requests });
}

/**
 * Record a DMS-backed service's responses to a file, to compare later with another DMS-backed
 * service that can't run at the same time (the PostgreSQL and SQL Server DMS stacks share
 * container names). The file holds the API output, no credentials.
 */
export async function runDmsRecord(argv) {
  const args = parseArgs(argv);
  if (!args.out) throw new Error('Set --out <file>');
  loadEnvFiles(args);
  const dms = await dmsService();
  const responses = await collectResponses(dms, {
    pageSize: args.pageSize, samples: args.samples, core: Boolean(process.env.DMS_CORE_KEY), assessment: args.assessment
  });
  const recording = { format: RECORDING_FORMAT, name: args.name || 'recorded', recordedAt: new Date().toISOString(), service: process.env.DMS_ONEROSTER_URL, responses };
  fs.writeFileSync(args.out, `${JSON.stringify(recording)}\n`, { mode: 0o600 });
  const items = Object.values(responses.collections).reduce((n, list) => n + list.length, 0);
  console.log(`${dms.requests} requests; ${Object.keys(responses.collections).length} collections, ${items} items; wrote ${args.out}`);
  return 0;
}

/** Compare a live DMS-backed service with a recording made by dms-record. */
export async function runDmsVsRecording(argv) {
  const args = parseArgs(argv);
  if (!args.recording) throw new Error('Set --recording <file>');
  loadEnvFiles(args);
  const recording = JSON.parse(fs.readFileSync(args.recording, 'utf8'));
  if (recording.format !== RECORDING_FORMAT) throw new Error(`${args.recording} is not a ${RECORDING_FORMAT} file`);
  const core = CORE_CASE in recording.responses.errors;
  if (core && !process.env.DMS_CORE_KEY) throw new Error('The recording has the roster-core case: set DMS_CORE_KEY / DMS_CORE_SECRET');
  const dms = await dmsService();
  // A recording made with the assessment collections is compared with them
  const assessment = args.assessment || Object.keys(recording.responses.collections).some(label => label.endsWith(' assessments'));
  const live = await collectResponses(dms, { pageSize: args.pageSize, sampleIds: recording.responses.singles, core, assessment });
  const names = [recording.name, args.name || 'live'];
  console.log(`Recorded ${recording.recordedAt} from ${recording.service} (${recording.name}); live ${process.env.DMS_ONEROSTER_URL} (${names[1]})`);
  return report(compareResponses(recording.responses, live, { names }), { names, known: loadKnown(args), requests: dms.requests });
}
