#!/usr/bin/env node

/**
 * PostgreSQL OneRoster Schema Deployment Script
 * 
 * This script deploys the complete OneRoster 1.2 schema to PostgreSQL.
 * It supports both Ed-Fi Data Standard 4 and 5 databases.
 * 
 * Usage:
 *   node sql/postgres/deploy_postgres.js           # Defaults to DS5
 *   node sql/postgres/deploy_postgres.js --ds4     # Deploy for DS4
 *   node sql/postgres/deploy_postgres.js --ds5     # Deploy for DS5
 *   
 * Requirements:
 *   - Node.js with pg package
 *   - .env file with PostgreSQL connection settings
 *   - PostgreSQL 12+ with JSON support
 *   - Appropriate database permissions
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Load environment variables from project root
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Parse command line arguments
const args = process.argv.slice(2);
const dataStandard = args.includes('--ds4') ? 'DS4' : 'DS5';

// PostgreSQL Connection Configuration
const config = {
    host: process.env.DB_HOST || process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || process.env.POSTGRES_PORT) || 5432,
    database: process.env.DB_NAME || process.env.POSTGRES_DATABASE || 'EdFi_Ods_Sandbox_populatedKey',
    user: process.env.DB_USER || process.env.POSTGRES_USER || 'postgres',
    password: process.env.DB_PASS || process.env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 30000,
    query_timeout: 120000  // Extended timeout for large deployments
};

// SQL files in deployment order (PostgreSQL version)
const deploymentOrder = [
    // Phase 1: Foundation
    '00_setup.sql',
    '01_descriptors.sql', 
    '02_descriptorMappings.sql',
    
    // Phase 2: Core Views
    'orgs.sql',
    'academic_sessions.sql',
    'courses.sql',
    'classes.sql',
    'demographics.sql',
    dataStandard === 'DS4' ? 'users_ds4.sql' : 'users.sql',  // DS4/DS5 specific
    'enrollments.sql'
];

/**
 * Print a formatted deployment header
 */
function printHeader() {
    console.log('========================================');
    console.log('OneRoster 1.2 PostgreSQL Deployment');
    console.log('========================================');
    console.log(`Data Standard: ${dataStandard}`);
    console.log(`Target Host: ${config.host}:${config.port}`);
    console.log(`Target Database: ${config.database}`);
    console.log(`User: ${config.user}`);
    console.log(`Deployment Time: ${new Date().toISOString()}`);
    console.log('========================================\n');
}

/**
 * Check deployment prerequisites
 */
async function checkPrerequisites(client) {
    console.log('🔍 Checking prerequisites...\n');
    
    try {
        // Check PostgreSQL version
        const versionResult = await client.query(`
            SELECT version() as version_string,
                   current_database() as database_name,
                   current_user as current_user
        `);
        
        const versionInfo = versionResult.rows[0];
        console.log(`✅ Database: ${versionInfo.database_name}`);
        console.log(`✅ User: ${versionInfo.current_user}`);
        console.log(`✅ PostgreSQL Version: ${versionInfo.version_string.split(' ').slice(0, 2).join(' ')}`);
        
        // Check if this looks like an Ed-Fi database
        const edfiCheck = await client.query(`
            SELECT COUNT(*) as schema_count 
            FROM information_schema.schemata 
            WHERE schema_name = 'edfi'
        `);
        
        if (parseInt(edfiCheck.rows[0].schema_count) > 0) {
            console.log('✅ Ed-Fi schema detected');
            
            // Detect actual data standard version
            const ds4Check = await client.query(`
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables 
                    WHERE table_schema = 'edfi' AND table_name = 'parent'
                ) as is_ds4
            `);
            
            const ds5Check = await client.query(`
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables 
                    WHERE table_schema = 'edfi' AND table_name = 'contact'
                ) as is_ds5
            `);
            
            const isDS4 = ds4Check.rows[0].is_ds4;
            const isDS5 = ds5Check.rows[0].is_ds5;
            
            if (isDS4 && !isDS5) {
                console.log('✅ Detected Ed-Fi Data Standard 4 database');
                if (dataStandard !== 'DS4') {
                    console.log('⚠️  WARNING: Database is DS4 but deploying DS5 scripts. Use --ds4 flag.');
                }
            } else if (!isDS4 && isDS5) {
                console.log('✅ Detected Ed-Fi Data Standard 5 database');
                if (dataStandard !== 'DS5') {
                    console.log('⚠️  WARNING: Database is DS5 but deploying DS4 scripts. Use --ds5 flag.');
                }
            } else {
                console.log('⚠️  WARNING: Could not determine Ed-Fi Data Standard version');
            }
        } else {
            console.log('⚠️  WARNING: No "edfi" schema found. Ensure this is an Ed-Fi ODS database.');
        }
        
        // Check for existing oneroster12 schema
        const onerosterCheck = await client.query(`
            SELECT COUNT(*) as schema_count 
            FROM information_schema.schemata 
            WHERE schema_name = 'oneroster12'
        `);
        
        if (parseInt(onerosterCheck.rows[0].schema_count) > 0) {
            console.log('⚠️  WARNING: oneroster12 schema already exists. Existing objects will be replaced.');
        }
        
        console.log('');
        
    } catch (err) {
        console.error('❌ Prerequisites check failed:', err.message);
        throw err;
    }
}

/**
 * Execute a single SQL file
 */
async function executeSQLFile(client, filename, fileIndex, totalFiles) {
    const basePath = path.join(__dirname, '..');
    const filePath = path.join(basePath, filename);
    
    if (!fs.existsSync(filePath)) {
        console.log(`⚠️  Warning: ${filename} not found, skipping...`);
        return { success: false, skipped: true };
    }
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        
        console.log(`⚡ [${fileIndex}/${totalFiles}] Executing ${filename}`);
        
        // PostgreSQL can execute the entire file at once
        await client.query(content);
        
        console.log(`    ✅ ${filename} completed successfully\n`);
        
        return { success: true };
        
    } catch (err) {
        console.log(`    ❌ ${filename}: ${err.message}\n`);
        
        // Log more details if debug mode
        if (process.env.DEBUG_SQL) {
            console.log(`    📝 Full error:`, err);
        }
        
        return { success: false, error: err.message };
    }
}

/**
 * Refresh a specific materialized view
 */
async function refreshMaterializedView(client, viewName) {
    try {
        console.log(`    🔄 Refreshing ${viewName}...`);
        await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY oneroster12.${viewName}`);
        console.log(`    ✅ ${viewName} refreshed`);
        return true;
    } catch (err) {
        // Try without CONCURRENTLY if it fails (first time refresh)
        try {
            await client.query(`REFRESH MATERIALIZED VIEW oneroster12.${viewName}`);
            console.log(`    ✅ ${viewName} refreshed (initial)`);
            return true;
        } catch (err2) {
            console.log(`    ❌ Failed to refresh ${viewName}: ${err2.message}`);
            return false;
        }
    }
}

/**
 * Generate deployment summary
 */
async function generateSummary(client) {
    console.log('\n📊 DEPLOYMENT SUMMARY');
    console.log('========================================');
    
    try {
        // Check schemas
        const schemasResult = await client.query(`
            SELECT schema_name FROM information_schema.schemata 
            WHERE schema_name = 'oneroster12'
        `);
        console.log(`Schemas: ${schemasResult.rows.length > 0 ? '✅ oneroster12' : '❌ None'}`);
        
        // Check materialized views
        const viewsResult = await client.query(`
            SELECT matviewname 
            FROM pg_matviews 
            WHERE schemaname = 'oneroster12'
            ORDER BY matviewname
        `);
        
        console.log(`\nMaterialized Views (${viewsResult.rows.length}):`);
        if (viewsResult.rows.length > 0) {
            for (const row of viewsResult.rows) {
                // Check row count
                try {
                    const countResult = await client.query(
                        `SELECT COUNT(*) as count FROM oneroster12.${row.matviewname}`
                    );
                    console.log(`  ✅ ${row.matviewname} (${countResult.rows[0].count} rows)`);
                } catch (e) {
                    console.log(`  ⚠️  ${row.matviewname} (unable to count rows)`);
                }
            }
        } else {
            console.log('  ❌ No materialized views found');
        }
        
        // Check functions
        const functionsResult = await client.query(`
            SELECT routine_name 
            FROM information_schema.routines 
            WHERE routine_schema = 'oneroster12' 
            AND routine_type = 'FUNCTION'
            ORDER BY routine_name
        `);
        
        if (functionsResult.rows.length > 0) {
            console.log(`\nFunctions (${functionsResult.rows.length}):`);
            functionsResult.rows.forEach(row => {
                console.log(`  ✅ ${row.routine_name}`);
            });
        }
        
        // Check indexes
        const indexesResult = await client.query(`
            SELECT indexname, tablename
            FROM pg_indexes
            WHERE schemaname = 'oneroster12'
            ORDER BY tablename, indexname
        `);
        
        if (indexesResult.rows.length > 0) {
            console.log(`\nIndexes (${indexesResult.rows.length}):`);
            const indexesByTable = {};
            indexesResult.rows.forEach(row => {
                if (!indexesByTable[row.tablename]) {
                    indexesByTable[row.tablename] = [];
                }
                indexesByTable[row.tablename].push(row.indexname);
            });
            
            Object.keys(indexesByTable).forEach(table => {
                console.log(`  ✅ ${table}: ${indexesByTable[table].join(', ')}`);
            });
        }
        
        // Check for users with null roles (known issue)
        try {
            const nullRolesResult = await client.query(`
                SELECT COUNT(*) as count 
                FROM oneroster12.users 
                WHERE role IS NULL
            `);
            if (parseInt(nullRolesResult.rows[0].count) > 0) {
                console.log(`\n⚠️  Note: ${nullRolesResult.rows[0].count} users have null roles (district-level staff)`);
            }
        } catch (e) {
            // View might not exist yet
        }
        
        // Final recommendations
        console.log('\n📋 NEXT STEPS:');
        console.log('1. Verify OneRoster API endpoints are working');
        console.log('2. Set up cron job or pg_cron for automated refresh');
        console.log('3. Test API performance and tune as needed');
        console.log('4. Consider creating refresh procedures for automation');
        
    } catch (err) {
        console.log('⚠️  Could not generate complete summary:', err.message);
    }
}

/**
 * Main deployment function
 */
async function deployPostgreSQLSchema() {
    printHeader();
    
    const client = new Client(config);
    
    try {
        console.log('🔌 Connecting to PostgreSQL...');
        await client.connect();
        console.log('✅ Connected successfully\n');
        
        // Check prerequisites
        await checkPrerequisites(client);
        
        // Execute deployment phases
        const phases = [
            { name: 'Phase 1: Foundation Setup', files: deploymentOrder.slice(0, 3) },
            { name: 'Phase 2: Materialized Views', files: deploymentOrder.slice(3) }
        ];
        
        let totalSuccess = 0;
        let totalErrors = 0;
        let fileIndex = 0;
        
        for (const phase of phases) {
            console.log(`\n=== ${phase.name} ===`);
            
            for (const file of phase.files) {
                fileIndex++;
                const result = await executeSQLFile(client, file, fileIndex, deploymentOrder.length);
                
                if (result.skipped) continue;
                if (result.success) totalSuccess++;
                else totalErrors++;
            }
            
            console.log(`✅ ${phase.name} completed\n`);
        }
        
        // Refresh materialized views if deployment was successful
        if (totalErrors === 0 || totalSuccess > 0) {
            console.log('\n=== Data Population ===');
            console.log('🔄 Refreshing materialized views...\n');
            
            const viewsToRefresh = [
                'orgs',
                'academicsessions',  // Note: view name doesn't have underscore
                'courses',
                'classes',
                'demographics',
                'users',
                'enrollments'
            ];
            
            let refreshSuccess = 0;
            for (const view of viewsToRefresh) {
                if (await refreshMaterializedView(client, view)) {
                    refreshSuccess++;
                }
            }
            
            if (refreshSuccess === viewsToRefresh.length) {
                console.log('\n✅ All materialized views refreshed successfully!');
            } else {
                console.log(`\n⚠️  ${refreshSuccess}/${viewsToRefresh.length} views refreshed successfully`);
            }
        }
        
        // Generate summary
        await generateSummary(client);
        
        // Final status
        console.log('\n========================================');
        if (totalErrors === 0) {
            console.log('🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!');
            console.log(`📊 Data Standard: ${dataStandard}`);
        } else if (totalSuccess > 0) {
            console.log(`⚠️  DEPLOYMENT COMPLETED WITH WARNINGS (${totalErrors} files had errors)`);
        } else {
            console.log('❌ DEPLOYMENT FAILED');
        }
        console.log(`📊 Files: ${totalSuccess} successful, ${totalErrors} failed`);
        console.log('========================================');
        
        await client.end();
        process.exit(totalErrors === 0 ? 0 : 1);
        
    } catch (err) {
        console.error('\n❌ DEPLOYMENT FAILED!');
        console.error('Error:', err.message);
        
        try {
            await client.end();
        } catch (e) {
            // Ignore cleanup errors
        }
        
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    deployPostgreSQLSchema();
}

module.exports = { deployPostgreSQLSchema };