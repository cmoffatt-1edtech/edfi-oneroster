import OneRosterQueryService from './OneRosterQueryService.js';
import MSSQLQueryService from './MSSQLQueryService.js';
import { knexManager } from '../../config/knex-factory.js';
import { getDataStoreProvider } from '../../platform/data-store-provider.js';
import { getLogger } from '../../utils/logger.js';

const logger = getLogger('DatabaseServiceFactory');

/**
 * Database Service Factory
 * Creates OneRoster query services with appropriate ODS database connections
 */

// Same key knexManager.createOdsInstance uses
const odsInstanceKey = (cacheKey, odsInstanceId) => cacheKey || `odsinstance-${odsInstanceId}`;
const refreshInstanceKey = (cacheKey, odsInstanceId) => `${odsInstanceKey(cacheKey, odsInstanceId)}-refresh`;

class DatabaseServiceFactory {
  constructor() {
    this.services = new Map();
    this.connectionVersions = new Map(); // serviceKey -> connection version its pools were built with (DMS)
  }

  /**
   * Create OneRoster query service for database type
   * Requires OdsInstanceId to resolve correct ODS database
   * @param {string|null} [connectionVersion] - DMS: digest of the data store's connection strings
   *   (src/platform/dms/data-store-providers.js). Pools built from another version are retired, with
   *   their service if one was built, so a connection changed in the Configuration Service reaches the
   *   running service. That includes pools whose connection check failed, which have no service.
   */
  async createServiceForType(dbType, schema = 'oneroster12', tenantId = null, odsInstanceId = null, cacheKey = null, connectionVersion = null) {
    // Use provided cache key or build default service key
    const serviceKey = cacheKey || `${dbType}_${tenantId || 'default'}_${odsInstanceId || 'default'}_${schema}`;

    if (connectionVersion && this.connectionVersions.has(serviceKey) && this.connectionVersions.get(serviceKey) !== connectionVersion) {
      this.retireService(serviceKey, cacheKey, odsInstanceId);
    }

    if (!this.services.has(serviceKey)) {
      logger.info(`Creating ${dbType.toUpperCase()} service for schema '${schema}'${tenantId ? ` (tenant: ${tenantId})` : ''}${odsInstanceId ? ` (ODS: ${odsInstanceId})` : ''}${cacheKey ? ` [${cacheKey}]` : ''}`);

      try {
        let knexInstance;

        if (odsInstanceId) {
          // Resolve the connection string through the platform's data-store provider
          // (EdFi_Admin or external config on the ODS/API)
          const provider = getDataStoreProvider();
          const odsConnectionString = await provider.resolveConnectionString({
            tenantId,
            dataStoreId: odsInstanceId,
            dbType
          });

          // DMS with USE_READ_REPLICA: queries go to the replica, and the materialized views are
          // refreshed on the primary (a standby can't refresh them)
          const refreshConnectionString = provider.resolveRefreshConnectionString
            ? await provider.resolveRefreshConnectionString({ tenantId, dataStoreId: odsInstanceId })
            : null;

          // Create Knex instance with the resolved connection using flow-specific cache key
          knexInstance = knexManager.createOdsInstance(dbType, odsConnectionString, odsInstanceId, cacheKey, {
            refresh: !refreshConnectionString
          });
          if (refreshConnectionString) {
            knexManager.createOdsInstance(dbType, refreshConnectionString, odsInstanceId, refreshInstanceKey(cacheKey, odsInstanceId));
          }
          // Recorded before the connection check: a pool stays cached when the check fails
          if (connectionVersion) {
            this.connectionVersions.set(serviceKey, connectionVersion);
          }
        } else {
          throw new Error('OdsInstanceId is required to resolve an ODS database connection.');
        }

        // Test the connection and validate schema
        await this.testConnection(knexInstance, dbType, schema);

        // Create the service (use MSSQL-specific service for mssql database type)
        let service;
        if (dbType === 'mssql') {
          logger.debug(`Creating MSSQLQueryService for schema '${schema}'`);
          service = new MSSQLQueryService(knexInstance, schema);
        } else {
          logger.debug(`Creating OneRosterQueryService for schema '${schema}'`);
          service = new OneRosterQueryService(knexInstance, schema);
        }

        // Store for reuse
        this.services.set(serviceKey, service);

        logger.info(`${dbType.toUpperCase()} service created successfully`);
      } catch (error) {
        logger.error({ dbType, err: error }, 'Failed to create service');
        throw new Error(`Failed to create database service for ${dbType}: ${error.message}`);
      }
    }

    return this.services.get(serviceKey);
  }

  /**
   * Drop a cached service whose connection settings changed, and retire its Knex instances (the
   * query pool and, with a read replica, the primary used for refresh).
   */
  retireService(serviceKey, cacheKey, odsInstanceId) {
    logger.info(`Connection settings changed for ${serviceKey}; replacing its connections`);
    this.services.delete(serviceKey);
    this.connectionVersions.delete(serviceKey);
    knexManager.retireOdsInstance(odsInstanceKey(cacheKey, odsInstanceId));
    knexManager.retireOdsInstance(refreshInstanceKey(cacheKey, odsInstanceId));
  }

  /**
   * Test database connection and validate schema existence
   */
  async testConnection(knexInstance, dbType, schema = 'oneroster12') {
    try {
      // Step 1: Test basic connectivity
      await knexInstance.raw('SELECT 1 as test');
      logger.debug(`${dbType} connection test passed`);

      // Step 2: Validate schema exists
      let schemaExists = false;

      if (dbType === 'mssql') {
        // MSSQL: Check sys.schemas
        const result = await knexInstance.raw(`
          SELECT COUNT(*) as count
          FROM sys.schemas
          WHERE name = ?
        `, [schema]);
        schemaExists = result[0]?.count > 0;
      } else {
        // PostgreSQL: Check information_schema.schemata
        const result = await knexInstance.raw(`
          SELECT COUNT(*) as count
          FROM information_schema.schemata
          WHERE schema_name = ?
        `, [schema]);
        schemaExists = result.rows?.[0]?.count > 0;
      }

      if (!schemaExists) {
        const error = `Schema '${schema}' does not exist in the database`;
        logger.error(error);
        throw new Error(error);
      }

      logger.debug(`Schema '${schema}' validation passed`);

    } catch (error) {
      logger.error({ dbType, err: error }, 'Connection/schema validation failed');
      throw error;
    }
  }

  /**
   * Close all services and connections
   */
  async closeAll() {
    logger.info('Closing all services...');

    // Close all query services
    const closePromises = Array.from(this.services.values()).map(service =>
      service.close()
    );

    await Promise.all(closePromises);
    this.services.clear();
    this.connectionVersions.clear();

    // Close Knex manager connections
    await knexManager.closeAll();

    logger.info('All services closed');
  }
}

// Singleton instance
const databaseServiceFactory = new DatabaseServiceFactory();

/**
 * Get the default database service with two-level resolution
 */
async function getDefaultDatabaseService(tenantId = null, odsInstanceId = null, cacheKey = null, connectionVersion = null) {
  const dbType = process.env.DB_TYPE || 'postgres';
  return databaseServiceFactory.createServiceForType(dbType, 'oneroster12', tenantId, odsInstanceId, cacheKey, connectionVersion);
}

export {
  DatabaseServiceFactory,
  databaseServiceFactory,
  getDefaultDatabaseService
};
