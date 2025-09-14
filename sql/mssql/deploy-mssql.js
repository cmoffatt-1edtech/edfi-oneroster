#!/usr/bin/env node

/**
 * MSSQL OneRoster Schema Deployment Script
 * 
 * Executes SQL files in order to deploy OneRoster 1.2 schema.
 * Includes prerequisite checking and automatic data refresh.
 * 
 * Usage: node sql/mssql/deploy-mssql.js
 */

const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// Connection config
const config = {
    server: process.env.MSSQL_SERVER || 'localhost',
    database: process.env.MSSQL_DATABASE,
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    port: parseInt(process.env.MSSQL_PORT) || 1433,
    options: {
        encrypt: process.env.MSSQL_ENCRYPT === 'true',
        trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
        enableArithAbort: true
    },
    requestTimeout: 120000
};

// Deployment order
const sqlFiles = [
    '00_setup_mssql.sql',
    '01_descriptors_mssql.sql', 
    '02_descriptorMappings_mssql.sql',
    'academic_sessions_mssql.sql',
    'orgs_mssql.sql',
    'courses_mssql.sql',
    'classes_mssql.sql',
    'demographics_mssql.sql',
    'users_mssql.sql',
    'enrollments_mssql.sql',
    'master_refresh_mssql.sql',
    'sql_agent_job.sql'
];

async function executeSQLFile(pool, filename) {
    const filePath = path.join(__dirname, filename);
    
    if (!fs.existsSync(filePath)) {
        console.log(`❌ File not found: ${filename}`);
        return false;
    }
    
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        
        // Split on GO statements
        const batches = content
            .split(/^\s*GO\s*$/gmi)
            .map(batch => batch.trim())
            .filter(batch => batch.length > 5);
        
        console.log(`⚡ Executing ${filename} (${batches.length} batches)`);
        
        for (const batch of batches) {
            await pool.request().query(batch);
        }
        
        console.log(`✅ ${filename} completed`);
        return true;
        
    } catch (err) {
        console.log(`❌ ${filename} failed: ${err.message}`);
        return false;
    }
}

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
        } else {
            console.log('⚠️  WARNING: No "edfi" schema found. Ensure this is an Ed-Fi ODS database.');
        }
        
        console.log('');
        
    } catch (err) {
        console.error('❌ Prerequisites check failed:', err.message);
        throw err;
    }
}

async function runDataRefresh() {
    console.log('\\n=== Data Population ===');
    console.log('🔄 Running data refresh process...');
    
    // Run the refresh script in a separate process
    const refreshProcess = spawn('node', [path.join(__dirname, 'refresh-data.js')], {
        stdio: 'inherit',
        cwd: process.cwd()
    });
    
    return new Promise((resolve) => {
        refreshProcess.on('close', (code) => {
            if (code === 0) {
                console.log('\\n✅ Data population completed successfully!');
            } else {
                console.log('\\n⚠️  Data population completed with warnings or errors.');
            }
            resolve(code === 0);
        });
        refreshProcess.on('error', (err) => {
            console.error('\\n❌ Failed to run data refresh:', err.message);
            resolve(false);
        });
    });
}

async function deploy() {
    console.log('========================================');
    console.log('OneRoster 1.2 MSSQL Deployment');
    console.log('========================================');
    console.log(`Target Server: ${config.server}`);
    console.log(`Target Database: ${config.database}`);
    console.log(`User: ${config.user}`);
    console.log(`Deployment Time: ${new Date().toISOString()}`);
    console.log('========================================\\n');
    
    try {
        console.log('🔌 Connecting to SQL Server...');
        const pool = await sql.connect(config);
        console.log('✅ Connected successfully\\n');
        
        // Check prerequisites
        await checkPrerequisites(pool);
        
        let successCount = 0;
        let failCount = 0;
        
        for (const filename of sqlFiles) {
            const success = await executeSQLFile(pool, filename);
            if (success) {
                successCount++;
            } else {
                failCount++;
            }
        }
        
        await pool.close();
        
        // Run data refresh if deployment was successful
        let refreshSuccess = false;
        if (failCount === 0) {
            refreshSuccess = await runDataRefresh();
        }
        
        console.log('\\n========================================');
        if (failCount === 0) {
            console.log('🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!');
        } else {
            console.log(`⚠️  DEPLOYMENT COMPLETED WITH WARNINGS (${failCount} files had errors)`);
        }
        console.log(`📊 Files: ${successCount} successful, ${failCount} failed`);
        console.log('========================================');
        
        process.exit(failCount === 0 ? 0 : 1);
        
    } catch (err) {
        console.error('\\n❌ DEPLOYMENT FAILED!');
        console.error('Error:', err.message);
        process.exit(1);
    }
}

if (require.main === module) {
    deploy();
}

module.exports = { deploy };