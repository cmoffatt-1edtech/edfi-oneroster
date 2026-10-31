#!/usr/bin/env node

/**
 * MSSQL OneRoster Schema Deployment Script
 *
 * Executes SQL files in order to deploy OneRoster 1.2 schema.
 * Includes prerequisite checking and automatic data refresh.
 * Supports Ed-Fi Data Standard 4, 5 and 6.
 *
 * Usage:
 *   node standard/deploy-mssql.js [ds4|ds5|ds6]
 *   node standard/deploy-mssql.js ds4    # Deploy to DS4 database
 *   node standard/deploy-mssql.js ds5    # Deploy to DS5 database (default)
 *   node standard/deploy-mssql.js ds6    # Deploy to DS6 database
 *   node standard/deploy-mssql.js        # Deploy to DS5 database (default)
 */

import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { buildMssqlTlsOptionsFromEnv } from '../src/config/mssql-tls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments for data standard
const args = process.argv.slice(2);
let dataStandard = 'ds5'; // default

// Parse arguments: first arg might be data standard (ds4/ds5/ds6)
if (args.length > 0) {
    if (args[0] === 'ds4' || args[0] === 'ds5' || args[0] === 'ds6') {
        dataStandard = args[0];
    } else {
        console.error(`❌ Invalid data standard: ${args[0]}`);
        console.log('Usage: node standard/deploy-mssql.js [ds4|ds5|ds6]');
        console.log('Examples:');
        console.log('  node standard/deploy-mssql.js ds4    # Deploy to DS4 database');
        console.log('  node standard/deploy-mssql.js ds5    # Deploy to DS5 database (default)');
        console.log('  node standard/deploy-mssql.js ds6    # Deploy to DS6 database');
        console.log('  node standard/deploy-mssql.js        # Deploy to DS5 database (default)');
        process.exit(1);
    }
}

// Load environment from .env.deploy in the same folder as this script
const envPath = path.join(__dirname, '.env.deploy');
if (!fs.existsSync(envPath)) {
    console.error('❌ Could not load .env.deploy — file not found.');
    console.error('Copy standard/.env.deploy.example to standard/.env.deploy and fill in your values.');
    process.exit(1);
}
dotenv.config({ path: envPath });

// Connection config
const config = {
    server: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    port: parseInt(process.env.DB_PORT) || 1433,
    options: {
        ...buildMssqlTlsOptionsFromEnv(),
        enableArithAbort: true
    },
    requestTimeout: parseInt(process.env.MSSQL_REQUEST_TIMEOUT, 10) || 120000
};

function versionBasedDirectory(ds) {
    if (ds === 'ds4') {
        return path.join(__dirname, './4.0.0/artifacts/mssql');
    }
    else if (ds === 'ds5') {
        return path.join(__dirname, './5.2.0/artifacts/mssql');
    } else {
        return path.join(__dirname, './6.1.0/artifacts/mssql');
    }
}

// Build SQL file list dynamically from folder structure, maintaining order by numeric prefixes
function getSqlFilesInOrder(ds) {
    let baseDir, coreDir, jobsDir;
    baseDir = versionBasedDirectory(ds);
    coreDir = path.join(baseDir, 'core');
    jobsDir = path.join(baseDir, 'orchestration');

    const readSqlFiles = (dir, subdir) => {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(f => f.toLowerCase().endsWith('.sql'))
            .map(f => ({
                fullPath: path.join(dir, f),
                relPath: path.join(subdir, f).replace(/\\/g, '/'),
                name: f
            }));
    };

    const parsePrefix = (fileName) => {
        const m = /^([0-9]+)[-_]/.exec(fileName);
        return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
    };

    const coreFiles = readSqlFiles(coreDir, 'core');
    const jobFiles = readSqlFiles(jobsDir, 'orchestration');

    // Sort by numeric prefix; files without prefix go to the end
    const sortedCore = coreFiles.sort((a, b) => {
        const pa = parsePrefix(a.name);
        const pb = parsePrefix(b.name);
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name);
    });
    const sortedJobs = jobFiles.sort((a, b) => {
        const pa = parsePrefix(a.name);
        const pb = parsePrefix(b.name);
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name);
    });

    // Return relative paths for execution: core scripts first, then orchestration scripts
    return [...sortedCore.map(x => x.relPath), ...sortedJobs.map(x => x.relPath)];
}

const sqlFiles = getSqlFilesInOrder(dataStandard);

async function executeSQLFile(pool, filename) {
    var baseDir = versionBasedDirectory(dataStandard);
    const filePath = path.join(baseDir, filename);

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

        let batchNum = 0;
        for (const batch of batches) {
            batchNum++;
            try {
                await pool.request().query(batch);
            } catch (batchErr) {
                console.log(`\n❌ ${filename} failed in batch ${batchNum}/${batches.length}`);
                console.log(`   Error: ${batchErr.message}`);

                // Show context around the error
                if (batchErr.lineNumber && batchErr.procName) {
                    console.log(`   Location: Line ${batchErr.lineNumber} in ${batchErr.procName}`);
                }

                // Show a snippet of the failing batch
                const batchLines = batch.split('\n');
                if (batchLines.length <= 10) {
                    console.log(`\n   Failing SQL (full batch):\n   ${batchLines.join('\n   ')}`);
                } else {
                    const preview = batchLines.slice(0, 5);
                    console.log(`\n   Failing SQL (first 5 lines of batch):\n   ${preview.join('\n   ')}`);
                    console.log(`   ... (${batchLines.length - 5} more lines)`);
                }
                throw batchErr;
            }
        }

        console.log(`✅ ${filename} completed`);
        return true;

    } catch (err) {
        // Error already logged in the batch loop
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

        const agentStatus = await checkSqlServerAgent(pool);

        console.log('');
        return agentStatus;

    } catch (err) {
        console.error('❌ Prerequisites check failed:', err.message);
        throw err;
    }
}

// The SQL Server Agent job script is named sql_agent.sql (DS5, DS6) or sql_agent_job.sql (DS4).
function isAgentJobFile(relPath) {
    return /^sql_agent(_job)?\.sql$/i.test(path.basename(relPath));
}

// Returns 'running', 'stopped' or 'unknown'. The Agent job script fails wherever the
// Agent is not running (SQL Server Express, Azure SQL Database, containers without
// MSSQL_AGENT_ENABLED), so the deploy skips it there instead of failing.
async function checkSqlServerAgent(pool) {
    try {
        const serverResult = await pool.request().query(`
            SELECT
                CAST(SERVERPROPERTY('EngineEdition') AS INT) AS EngineEdition,
                HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS CanViewServerState
        `);
        const { EngineEdition, CanViewServerState } = serverResult.recordset[0];

        // EngineEdition 5 is Azure SQL Database, which has no SQL Server Agent.
        if (EngineEdition === 5) {
            console.log('⚠️  SQL Server Agent is not available on Azure SQL Database');
            return 'stopped';
        }

        // The Agent connects with program names such as 'SQLAgent - Generic Refresher'.
        const sessionResult = await pool.request().query(`
            SELECT COUNT(*) AS AgentSessions
            FROM sys.dm_exec_sessions
            WHERE program_name LIKE N'SQLAgent%'
        `);
        if (sessionResult.recordset[0].AgentSessions > 0) {
            console.log('✅ SQL Server Agent is running');
            return 'running';
        }

        // Without VIEW SERVER STATE a login sees only its own session, so no Agent
        // session proves nothing.
        if (CanViewServerState === 1) {
            console.log('⚠️  SQL Server Agent is not running');
            return 'stopped';
        }
        console.log('⚠️  SQL Server Agent status unknown (this login lacks VIEW SERVER STATE)');
        return 'unknown';
    } catch (err) {
        console.log(`⚠️  Could not check SQL Server Agent status: ${err.message}`);
        return 'unknown';
    }
}

async function runDataRefresh() {
    console.log('\\n=== Data Population ===');
    console.log('🔄 Running data refresh process...');

    // Run the refresh script in a separate process, passing the data standard
    const refreshProcess = spawn('node', [path.join(__dirname, 'refresh-data-mssql.js'), dataStandard], {
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
    console.log(`📊 Data Standard: ${dataStandard.toUpperCase()}`);
    console.log(`Target Server: ${config.server}`);
    console.log(`Target Database: ${config.database}`);
    console.log(`User: ${config.user}`);
    console.log(`Deployment Time: ${new Date().toISOString()}`);
    console.log('========================================\\n');

    try {
        console.log('🔌 Connecting to SQL Server...');
        const pool = await sql.connect(config);
        console.log('✅ Connected successfully\\n');

        // Check prerequisites (also reports whether SQL Server Agent is running)
        const agentStatus = await checkPrerequisites(pool);

        let successCount = 0;
        let failCount = 0;
        // Failures outside the Agent job script: the refresh procedures need all of these.
        let requiredFailCount = 0;
        const skippedFiles = [];

        for (const filename of sqlFiles) {
            const agentJobFile = isAgentJobFile(filename);
            if (agentJobFile && agentStatus === 'stopped') {
                console.log(`⚠️  Skipping ${filename}: SQL Server Agent is not running, so the scheduled refresh job cannot be created`);
                skippedFiles.push(filename);
                continue;
            }

            console.log('Executing file:', path.basename(filename));
            const success = await executeSQLFile(pool, filename);
            if (success) {
                successCount++;
            } else {
                failCount++;
                if (!agentJobFile) {
                    requiredFailCount++;
                }
            }
        }

        await pool.close();

        // The Agent job only schedules sp_refresh_all, so populate the tables whenever
        // the core and master refresh scripts deployed, with or without the job.
        if (requiredFailCount === 0) {
            let refreshSuccess = await runDataRefresh();

            if (refreshSuccess) {
                console.log('\\n✅ Data refresh completed successfully!');
            }
        }

        console.log('\\n========================================');
        if (failCount === 0) {
            console.log('🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!');
        } else {
            console.log(`⚠️  DEPLOYMENT COMPLETED WITH WARNINGS (${failCount} files had errors)`);
        }
        console.log(`📊 Files: ${successCount} successful, ${failCount} failed, ${skippedFiles.length} skipped`);
        if (skippedFiles.length > 0) {
            console.log('⚠️  No SQL Server Agent job was created. Schedule EXEC oneroster12.sp_refresh_all');
            console.log('   from another scheduler to keep the tables current');
            console.log('   (see "Running without SQL Server Agent" in standard/README_mssql.md).');
        }
        console.log('');
        console.log('🧪 Test deployment with:');
        console.log(`node tests/compare-database.js ${dataStandard}  # Test data parity`);
        console.log('========================================');

        process.exit(failCount === 0 ? 0 : 1);

    } catch (err) {
        console.error('\\n❌ DEPLOYMENT FAILED!');
        console.error('Error:', err.message);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    deploy();
}

export { deploy };
