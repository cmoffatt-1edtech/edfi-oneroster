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
 *   --known <file>    Differences already explained (JSON, see dms-parity-known-differences.json):
 *                     they are listed but don't fail the run. Exit code 1 means an unexplained
 *                     difference.
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

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const md5 = text => crypto.createHash('md5').update(text).digest('hex');

function parseArgs(argv) {
  const args = { excluded: ['5', '6', '7'], samples: 3, pageSize: 500, odsEnv: null, dmsEnv: null, known: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exclude-edorgs') args.excluded = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (argv[i] === '--samples') args.samples = Number(argv[++i]);
    else if (argv[i] === '--page-size') args.pageSize = Number(argv[++i]);
    else if (argv[i] === '--ods-env') args.odsEnv = argv[++i];
    else if (argv[i] === '--dms-env') args.dmsEnv = argv[++i];
    else if (argv[i] === '--known') args.known = argv[++i];
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
 * would hide it.
 * @returns {{ row: Object, diffs: Object[] }}
 */
export function compareCollection(label, odsItems, dmsItems) {
  const diffs = [];
  const odsById = new Map(odsItems.map(item => [item.sourcedId, withoutTimestamp(item)]));
  const dmsById = new Map(dmsItems.map(item => [item.sourcedId, withoutTimestamp(item)]));
  const row = { label, ods: odsItems.length, dms: dmsItems.length, identical: 0, orderOnly: 0, differ: 0, onlyOds: 0, onlyDms: 0, duplicates: 0 };
  for (const [side, items] of [['ODS', odsItems], ['DMS', dmsItems]]) {
    for (const [id, count] of repeatedIds(items)) {
      row.duplicates++;
      diffs.push({ label, sourcedId: id, kind: `duplicate on ${side}`, count });
    }
  }
  for (const [id, item] of odsById) {
    if (!dmsById.has(id)) { row.onlyOds++; diffs.push({ label, sourcedId: id, kind: 'only ODS' }); continue; }
    const other = dmsById.get(id);
    if (canonical(item, false) === canonical(other, false)) row.identical++;
    else if (canonical(item, true) === canonical(other, true)) row.orderOnly++;
    else { row.differ++; diffs.push({ label, sourcedId: id, kind: 'differs', ods: item, dms: other }); }
  }
  for (const id of dmsById.keys()) {
    if (!odsById.has(id)) { row.onlyDms++; diffs.push({ label, sourcedId: id, kind: 'only DMS' }); }
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

export async function runOdsVsDms(argv) {
  const args = parseArgs(argv);
  Object.assign(process.env, settingsFromEnvFiles({
    odsEnvText: args.odsEnv && fs.readFileSync(args.odsEnv, 'utf8'),
    dmsEnvText: args.dmsEnv && fs.readFileSync(args.dmsEnv, 'utf8')
  }));
  const ods = { base: `${requireEnv('ODS_ONEROSTER_URL').replace(/\/+$/, '')}/${ROSTER_PATH}`, tokenUrl: requireEnv('ODS_TOKEN_URL') };
  const dms = { base: `${requireEnv('DMS_ONEROSTER_URL').replace(/\/+$/, '')}/${ROSTER_PATH}`, tokenUrl: requireEnv('DMS_TOKEN_URL') };
  const excludedOrgs = new Set(args.excluded.map(md5));
  const excludedUsers = new Set();

  const clients = {
    lea: {
      ods: await token(ods.tokenUrl, requireEnv('ODS_LEA_KEY'), requireEnv('ODS_LEA_SECRET'), ODS_SCOPES),
      dms: await token(dms.tokenUrl, requireEnv('DMS_LEA_KEY'), requireEnv('DMS_LEA_SECRET'))
    },
    school: {
      ods: await token(ods.tokenUrl, requireEnv('ODS_SCHOOL_KEY'), requireEnv('ODS_SCHOOL_SECRET'), ODS_SCOPES),
      dms: await token(dms.tokenUrl, requireEnv('DMS_SCHOOL_KEY'), requireEnv('DMS_SCHOOL_SECRET'))
    }
  };

  const summary = [];
  const diffs = [];
  let requests = 0;

  const compareBodies = (label, odsItems, dmsItems) => {
    const result = compareCollection(label, odsItems, dmsItems);
    summary.push(result.row);
    diffs.push(...result.diffs);
  };

  // users first, so demographics can be excluded by the excluded students' sourcedIds
  const order = ['users', ...Object.keys(COLLECTIONS).filter(name => name !== 'users')];
  for (const [client, bearer] of Object.entries(clients)) {
    for (const collection of order) {
      const wrapper = COLLECTIONS[collection];
      const pages = { ods: [], dms: [] };
      for (const side of ['ods', 'dms']) {
        const base = side === 'ods' ? ods.base : dms.base;
        for (let offset = 0; ; offset += args.pageSize) {
          const res = await get(`${base}/${collection}?limit=${args.pageSize}&offset=${offset}`, bearer[side]);
          requests++;
          if (res.status !== 200) throw new Error(`${side} ${client} ${collection}: HTTP ${res.status}`);
          const items = res.body[wrapper] || [];
          pages[side].push(...items);
          if (items.length < args.pageSize) break;
        }
      }
      const kept = pages.ods.filter(item => !isExcluded(item, excludedOrgs, excludedUsers));
      if (collection === 'users') {
        pages.ods.filter(item => isExcluded(item, excludedOrgs, excludedUsers)).forEach(item => excludedUsers.add(item.sourcedId));
      }
      compareBodies(`${client} ${collection}`, kept, pages.dms);

      // Single items by id
      for (const item of pages.dms.slice(0, args.samples)) {
        const [a, b] = [await get(`${ods.base}/${collection}/${item.sourcedId}`, bearer.ods), await get(`${dms.base}/${collection}/${item.sourcedId}`, bearer.dms)];
        requests += 2;
        const strip = res => ({ status: res.status, body: Object.fromEntries(Object.entries(res.body || {}).map(([k, v]) => [k, withoutTimestamp(v)])) });
        if (canonical(strip(a), true) !== canonical(strip(b), true)) {
          diffs.push({ label: `${client} ${collection}/:id`, sourcedId: item.sourcedId, kind: 'single item differs', ods: a, dms: b });
        }
      }
    }
  }

  // Error responses
  const errorCases = [
    ['no token', 'orgs', null],
    ['malformed token', 'orgs', 'not.a.token'],
    ['bad limit', 'orgs?limit=abc', 'lea'],
    ['unknown id', `orgs/${'0'.repeat(32)}`, 'lea'],
    ['unknown path', 'nothing', 'lea'],
    ['bad filter field', `orgs?filter=${encodeURIComponent("password='x'")}`, 'lea']
  ];
  for (const [label, path, client] of errorCases) {
    const bearer = client === null ? [null, null] : client === 'lea' ? [clients.lea.ods, clients.lea.dms] : [client, client];
    const [a, b] = [await get(`${ods.base}/${path}`, bearer[0]), await get(`${dms.base}/${path}`, bearer[1])];
    requests += 2;
    if (canonical(a, false) !== canonical(b, false)) diffs.push({ label: `error: ${label}`, kind: 'error response differs', ods: a, dms: b });
  }

  // roster-core only: demographics must be refused the same way
  if (process.env.DMS_CORE_KEY) {
    const odsCore = await token(ods.tokenUrl, requireEnv('ODS_LEA_KEY'), requireEnv('ODS_LEA_SECRET'), `${SCOPE}roster-core.readonly`);
    const dmsCore = await token(dms.tokenUrl, process.env.DMS_CORE_KEY, requireEnv('DMS_CORE_SECRET'));
    const [a, b] = [await get(`${ods.base}/demographics`, odsCore), await get(`${dms.base}/demographics`, dmsCore)];
    requests += 2;
    if (a.status !== 403 || canonical(a, false) !== canonical(b, false)) diffs.push({ label: 'error: core scope on demographics', kind: 'error response differs', ods: a, dms: b });
  }

  console.log(`${'collection'.padEnd(22)} ${'ODS'.padStart(6)} ${'DMS'.padStart(6)} ${'same'.padStart(6)} order-only differ onlyODS onlyDMS dupes sameOrder`);
  for (const r of summary) {
    console.log(`${r.label.padEnd(22)} ${String(r.ods).padStart(6)} ${String(r.dms).padStart(6)} ${String(r.identical).padStart(6)} ${String(r.orderOnly).padStart(10)} ${String(r.differ).padStart(6)} ${String(r.onlyOds).padStart(7)} ${String(r.onlyDms).padStart(7)} ${String(r.duplicates).padStart(5)} ${r.sameOrder}`);
  }
  const known = args.known ? JSON.parse(fs.readFileSync(args.known, 'utf8')).differences : [];
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
