#!/usr/bin/env node

/**
 * MSSQL OneRoster Schema Deployment Script
 * 
 * This script deploys the complete OneRoster 1.2 schema to Microsoft SQL Server.
 * It supports both Ed-Fi Data Standard 4 and 5 databases.
 * It replaces the non-functional deploy_all_mssql.sql which uses unsupported :r includes.
 * 
 * Usage:
 *   node sql/mssql/deploy_mssql.js           # Defaults to DS5
 *   node sql/mssql/deploy_mssql.js --ds4     # Deploy for DS4
 *   node sql/mssql/deploy_mssql.js --ds5     # Deploy for DS5
 *   
 * Requirements:
 *   - Node.js with mssql package
 *   - .env file with MSSQL connection settings
 *   - SQL Server 2016+ with JSON support
 *   - Appropriate database permissions
 */

const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Load environment variables from project root
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Parse command line arguments
const args = process.argv.slice(2);
const dataStandard = args.includes('--ds4') ? 'DS4' : 'DS5';

// MSSQL Connection Configuration
const config = {
    server: process.env.MSSQL_SERVER || 'localhost',
    database: process.env.MSSQL_DATABASE || 'EdFi_Ods_Populated_Template',
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    port: parseInt(process.env.MSSQL_PORT) || 1433,
    options: {
        encrypt: process.env.MSSQL_ENCRYPT === 'true',
        trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
        enableArithAbort: true
    },
    connectionTimeout: 30000,
    requestTimeout: 120000  // Extended timeout for large deployments
};

// SQL files in deployment order (MSSQL version)
const deploymentOrder = [
    // Phase 1: Foundation
    '00_setup_mssql.sql',
    '01_descriptors_mssql.sql', 
    '02_descriptorMappings_mssql.sql',
    
    // Phase 2: Core Tables and Procedures
    '03_tables_mssql.sql',
    'academic_sessions_mssql.sql',
    'orgs_mssql.sql',
    'courses_mssql.sql',
    'classes_mssql.sql',
    'demographics_mssql.sql',
    dataStandard === 'DS4' ? 'users_ds4_mssql.sql' : 'users_mssql.sql',  // DS4/DS5 specific
    'enrollments_mssql.sql',
    
    // Phase 3: Orchestration and Optimization
    'indexes_mssql.sql',
    'sql_agent_job.sql'
];

/**
 * Print a formatted deployment header
 */
function printHeader() {
    console.log('========================================');
    console.log('OneRoster 1.2 MSSQL Deployment');
    console.log('========================================');
    console.log(`Data Standard: ${dataStandard}`);
    console.log(`Target Server: ${config.server}`);
    console.log(`Target Database: ${config.database}`);
    console.log(`User: ${config.user}`);
    console.log(`Deployment Time: ${new Date().toISOString()}`);
    console.log('========================================\n');
}

/**
 * Check deployment prerequisites
 */
async function checkPrerequisites(pool) {
    console.log('🔍 Checking prerequisites...\n');
    
    try {
        // Check SQL Server version (need 2016+ for JSON support)
        const versionResult = await pool.request().query(`
            SELECT 
                SERVERPROPERTY('ProductMajorVersion') as MajorVersion,
                @@VERSION as VersionString,
                DB_NAME() as DatabaseName
        `);
        
        const majorVersion = versionResult.recordset[0].MajorVersion;
        const versionString = versionResult.recordset[0].VersionString;
        const databaseName = versionResult.recordset[0].DatabaseName;
        
        console.log(`✅ Database: ${databaseName}`);
        console.log(`✅ SQL Server Version: ${majorVersion} (${versionString.split('\\n')[0]})`);
        
        if (majorVersion < 13) {
            throw new Error(`SQL Server 2016 or later is required for JSON support. Current version: ${majorVersion}`);
        }
        
        // Check if this looks like an Ed-Fi database
        const edfiCheck = await pool.request().query(`
            SELECT COUNT(*) as SchemaCount 
            FROM sys.schemas 
            WHERE name = 'edfi'
        `);
        
        if (edfiCheck.recordset[0].SchemaCount > 0) {
            console.log('✅ Ed-Fi schema detected');
            
            // Detect actual data standard version
            const ds4Check = await pool.request().query(`
                SELECT CASE WHEN EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_SCHEMA = 'edfi' AND TABLE_NAME = 'Parent'
                ) THEN 1 ELSE 0 END as IsDS4
            `);
            
            const ds5Check = await pool.request().query(`
                SELECT CASE WHEN EXISTS (
                    SELECT 1 FROM INFORMATION_SCHEMA.TABLES 
                    WHERE TABLE_SCHEMA = 'edfi' AND TABLE_NAME = 'Contact'
                ) THEN 1 ELSE 0 END as IsDS5
            `);
            
            const isDS4 = ds4Check.recordset[0].IsDS4 === 1;
            const isDS5 = ds5Check.recordset[0].IsDS5 === 1;
            
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
        
        // Check SQL Server Agent (optional)
        try {
            const agentCheck = await pool.request().query(`
                SELECT COUNT(*) as AgentRunning
                FROM sys.dm_server_services 
                WHERE servicename LIKE 'SQL Server Agent%' AND status = 4
            `);
            
            if (agentCheck.recordset[0].AgentRunning > 0) {
                console.log('✅ SQL Server Agent is running');
            } else {
                console.log('⚠️  WARNING: SQL Server Agent is not running. Jobs will not execute automatically.');
            }
        } catch (e) {
            console.log('⚠️  WARNING: Could not check SQL Server Agent status');
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
async function executeSQLFile(pool, filename, phase, fileIndex, totalFiles) {
    const filePath = path.join(__dirname, filename);
    
    if (!fs.existsSync(filePath)) {
        console.log(`⚠️  Warning: ${filename} not found, skipping...`);
        return { success: false, skipped: true };
    }
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Split on GO statements and filter out empty batches
        const batches = content
            .split(/^\s*GO\s*$/gmi)
            .map(batch => batch.trim())
            .filter(batch => batch.length > 10 && !batch.match(/^\s*--.*$/));
        
        console.log(`⚡ [${fileIndex}/${totalFiles}] Executing ${filename} (${batches.length} batches)`);
        
        let batchSuccessCount = 0;
        let batchErrorCount = 0;
        
        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            try {
                await pool.request().query(batch);
                batchSuccessCount++;
            } catch (batchErr) {
                batchErrorCount++;
                console.log(`    ❌ Batch ${i + 1} failed: ${batchErr.message.split('\\n')[0]}`);
                console.log(`    🔍 Failed SQL snippet: ${batch.substring(0, 200)}...`);
                
                // Log the full error for debugging
                if (process.env.DEBUG_SQL) {
                    console.log(`    📝 Full error: ${batchErr.message}`);
                    console.log(`    📝 Full batch: ${batch}`);
                }
                
                // Continue with other batches (some errors might be expected)
            }
        }
        
        const status = batchErrorCount === 0 ? '✅' : (batchSuccessCount > 0 ? '⚠️ ' : '❌');
        console.log(`    ${status} ${filename}: ${batchSuccessCount} successful, ${batchErrorCount} failed\\n`);
        
        return { 
            success: batchErrorCount === 0, 
            partial: batchSuccessCount > 0 && batchErrorCount > 0,
            batchSuccessCount, 
            batchErrorCount 
        };
        
    } catch (err) {
        console.log(`    ❌ ${filename}: ${err.message}\\n`);
        return { success: false, error: err.message };
    }
}


/**
 * Generate deployment summary
 */
async function generateSummary(pool) {
    console.log('\\n📊 DEPLOYMENT SUMMARY');
    console.log('========================================');
    
    try {
        // Check schemas
        const schemasResult = await pool.request().query(`
            SELECT name FROM sys.schemas WHERE name = 'oneroster12'
        `);
        console.log(`Schemas: ${schemasResult.recordset.length > 0 ? '✅ oneroster12' : '❌ None'}`);
        
        // Check tables
        const tablesResult = await pool.request().query(`
            SELECT TABLE_NAME 
            FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = 'oneroster12' AND TABLE_TYPE = 'BASE TABLE'
            ORDER BY TABLE_NAME
        `);
        
        console.log(`\\nTables (${tablesResult.recordset.length}):`);
        if (tablesResult.recordset.length > 0) {
            tablesResult.recordset.forEach(row => {
                console.log(`  ✅ ${row.TABLE_NAME}`);
            });
        } else {
            console.log('  ❌ No tables found');
        }
        
        // Check stored procedures
        const procsResult = await pool.request().query(`
            SELECT ROUTINE_NAME 
            FROM INFORMATION_SCHEMA.ROUTINES 
            WHERE ROUTINE_SCHEMA = 'oneroster12' AND ROUTINE_TYPE = 'PROCEDURE'
            ORDER BY ROUTINE_NAME
        `);
        
        console.log(`\\nStored Procedures (${procsResult.recordset.length}):`);
        if (procsResult.recordset.length > 0) {
            procsResult.recordset.forEach(row => {
                console.log(`  ✅ ${row.ROUTINE_NAME}`);
            });
        } else {
            console.log('  ❌ No procedures found');
        }
        
        // Check SQL Server Agent jobs (optional)
        try {
            const jobsResult = await pool.request().query(`
                SELECT name, enabled, description
                FROM msdb.dbo.sysjobs 
                WHERE name LIKE '%OneRoster%'
            `);
            
            console.log(`\\nSQL Server Agent Jobs (${jobsResult.recordset.length}):`);
            if (jobsResult.recordset.length > 0) {
                jobsResult.recordset.forEach(row => {
                    const status = row.enabled ? '✅' : '⚠️ ';
                    console.log(`  ${status} ${row.name} (${row.enabled ? 'Enabled' : 'Disabled'})`);
                });
            } else {
                console.log('  ⚠️  No OneRoster jobs found');
            }
        } catch (e) {
            console.log('\\nSQL Server Agent Jobs: ⚠️  Could not check jobs');
        }
        
        // Final recommendations
        console.log('\\n📋 NEXT STEPS:');
        console.log('1. Verify OneRoster API endpoints are working');
        console.log('2. Set up monitoring for automated refresh jobs');
        console.log('3. Test API performance and tune as needed');
        console.log('4. Review refresh_history table for ongoing monitoring');
        
    } catch (err) {
        console.log('⚠️  Could not generate complete summary:', err.message);
    }
}

/**
 * Main deployment function
 */
async function deployMSSQLSchema() {
    printHeader();
    
    try {
        console.log('🔌 Connecting to SQL Server...');
        let pool = await sql.connect(config);
        console.log('✅ Connected successfully\\n');
        
        // Check prerequisites
        await checkPrerequisites(pool);
        
        // Execute deployment phases
        const phases = [
            { name: 'Phase 1: Foundation Setup', files: deploymentOrder.slice(0, 3) },
            { name: 'Phase 2: Tables and Procedures', files: deploymentOrder.slice(3, 11) },
            { name: 'Phase 3: Orchestration and Optimization', files: deploymentOrder.slice(11) }
        ];
        
        let totalSuccess = 0;
        let totalErrors = 0;
        let totalPartial = 0;
        
        for (const phase of phases) {
            console.log(`\\n=== ${phase.name} ===`);
            
            for (let i = 0; i < phase.files.length; i++) {
                const result = await executeSQLFile(pool, phase.files[i], phase.name, i + 1, phase.files.length);
                
                if (result.skipped) continue;
                if (result.success) totalSuccess++;
                else if (result.partial) totalPartial++;
                else totalErrors++;
            }
            
            console.log(`✅ ${phase.name} completed\\n`);
        }
        
        // Run initial data refresh if deployment was successful
        if (totalErrors === 0 || totalSuccess > 0) {
            console.log('\\n=== Data Population ===');
            console.log('🔄 Running separate data refresh process...');
            
            // Close the current pool to avoid connection conflicts
            await pool.close();
            
            // Run the refresh script in a separate process
            const refreshProcess = spawn('node', [path.join(__dirname, 'refresh-data.js')], {
                stdio: 'inherit',
                cwd: process.cwd()
            });
            
            await new Promise((resolve, reject) => {
                refreshProcess.on('close', (code) => {
                    if (code === 0) {
                        console.log('\\n✅ Data population completed successfully!');
                        resolve();
                    } else {
                        console.log('\\n⚠️  Data population completed with warnings or errors.');
                        resolve(); // Don't fail the whole deployment
                    }
                });
                refreshProcess.on('error', (err) => {
                    console.error('\\n❌ Failed to run data refresh:', err.message);
                    resolve(); // Don't fail the whole deployment
                });
            });
            
            // Reconnect for summary
            const summaryPool = await sql.connect(config);
            // Generate summary
            await generateSummary(summaryPool);
            pool = summaryPool; // Use summaryPool for final status
        } else {
            // Generate summary with existing pool
            await generateSummary(pool);
        }
        
        // Final status
        console.log('\\n========================================');
        if (totalErrors === 0) {
            console.log('🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!');
            console.log(`📊 Data Standard: ${dataStandard}`);
        } else if (totalSuccess > 0) {
            console.log(`⚠️  DEPLOYMENT COMPLETED WITH WARNINGS (${totalErrors} files had errors)`);
        } else {
            console.log('❌ DEPLOYMENT FAILED');
        }
        console.log(`📊 Files: ${totalSuccess} successful, ${totalPartial} partial, ${totalErrors} failed`);
        console.log('========================================');
        
        await pool.close();
        process.exit(totalErrors === 0 ? 0 : 1);
        
    } catch (err) {
        console.error('\\n❌ DEPLOYMENT FAILED!');
        console.error('Error:', err.message);
        process.exit(1);
    }
}

// Run if called directly
if (require.main === module) {
    deployMSSQLSchema();
}

module.exports = { deployMSSQLSchema };