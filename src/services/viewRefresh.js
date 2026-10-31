// SPDX-License-Identifier: Apache-2.0
// Licensed to 1EdTech Consortium, Inc. under one or more agreements.
// 1EdTech Consortium, Inc. licenses this file to you under the Apache License, Version 2.0.
// See the LICENSE and NOTICES files in the project root for more information.

import { isDmsPlatform } from '../config/platform.js';
import { getLogger } from '../utils/logger.js';

const logger = getLogger('ViewRefresh');

const VIEW_NAME = /^[a-z]+$/;

/**
 * Refresh one oneroster12 materialized view.
 *
 * On the ODS/API this is a plain REFRESH, as before. On Ed-Fi API v8 (DMS), when the data store
 * has the change tracking that standard/deploy-dms.js creates, the refresh is skipped while the
 * view's sources are unchanged:
 *
 * - oneroster12.source_version(view) is the highest DMS change version among the view's source
 *   resources (inserts and updates in "ContentVersion", deletes in tracked_changes_*).
 * - The version is read and the view refreshed in one REPEATABLE READ transaction, so the refresh
 *   sees exactly the data the version describes, and the version is recorded in
 *   oneroster12.refresh_state.
 * - Change versions come from a sequence, so a write in flight when the version is read can commit
 *   later with a lower version than the one recorded. If any write was in flight
 *   (txid_snapshot_xip), the state is recorded as incomplete and the next run refreshes regardless.
 *   Under steady writes that means refreshing every time, as without tracking; skipping never
 *   misses a change.
 *
 * @param {import('knex').Knex} knexInstance - the data store's primary
 * @param {string} view - a oneroster12 view name (lowercase letters only)
 * @returns {Promise<{refreshed: boolean, tracked: boolean, sourceVersion?: string, complete?: boolean}>}
 */
export async function refreshView(knexInstance, view) {
  if (!VIEW_NAME.test(view)) {
    throw new Error(`Invalid view name: ${view}`);
  }

  if (!isDmsPlatform() || !(await hasChangeTracking(knexInstance))) {
    await knexInstance.raw(`REFRESH MATERIALIZED VIEW oneroster12.${view}`);
    return { refreshed: true, tracked: false };
  }

  return knexInstance.transaction(async trx => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const { rows: [current] } = await trx.raw(
      `SELECT oneroster12.source_version(?)::text AS version,
              cardinality(array(SELECT txid_snapshot_xip(txid_current_snapshot()))) = 0 AS complete`,
      [view]
    );
    if (current.version === null) {
      // A view the deployed function doesn't know: refresh it untracked
      await trx.raw(`REFRESH MATERIALIZED VIEW oneroster12.${view}`);
      return { refreshed: true, tracked: false };
    }

    const { rows: [state] } = await trx.raw(
      'SELECT source_version::text AS version, complete FROM oneroster12.refresh_state WHERE view_name = ?',
      [view]
    );
    if (state && state.complete && BigInt(current.version) <= BigInt(state.version)) {
      logger.debug({ view, sourceVersion: current.version }, 'Sources unchanged; refresh skipped');
      return { refreshed: false, tracked: true, sourceVersion: current.version, complete: true };
    }

    await trx.raw(`REFRESH MATERIALIZED VIEW oneroster12.${view}`);
    await trx.raw(
      `INSERT INTO oneroster12.refresh_state (view_name, source_version, complete, refreshed_at)
       VALUES (?, ?::bigint, ?, now())
       ON CONFLICT (view_name) DO UPDATE
         SET source_version = EXCLUDED.source_version, complete = EXCLUDED.complete, refreshed_at = EXCLUDED.refreshed_at`,
      [view, current.version, current.complete]
    );
    return { refreshed: true, tracked: true, sourceVersion: current.version, complete: current.complete };
  });
}

/**
 * Whether a oneroster12 materialized view exists in this data store. Optional views (assessment
 * rostering) are absent on Data Standard 4.0 and wherever they weren't deployed, and their
 * refresh jobs skip those data stores rather than fail.
 * @param {import('knex').Knex} knexInstance
 * @param {string} view - a oneroster12 view name
 * @returns {Promise<boolean>}
 */
export async function matviewExists(knexInstance, view) {
  const { rows } = await knexInstance.raw(
    "SELECT 1 FROM pg_matviews WHERE schemaname = 'oneroster12' AND matviewname = ?",
    [view]
  );
  return rows.length > 0;
}

async function hasChangeTracking(knexInstance) {
  const { rows: [probe] } = await knexInstance.raw(
    `SELECT to_regprocedure('oneroster12.source_version(text)') IS NOT NULL
        AND to_regclass('oneroster12.refresh_state') IS NOT NULL AS tracked`
  );
  return probe.tracked === true;
}
