const sql = require('mssql');

// MSSQL connection pool configuration
const config = {
    server: process.env.MSSQL_SERVER || 'localhost',
    database: process.env.MSSQL_DATABASE,
    connectionTimeout: 30000,
    requestTimeout: 30000,
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    },
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true,
        useUTC: false
    }
};

// Add authentication based on whether credentials are provided
if (process.env.MSSQL_USER && process.env.MSSQL_PASSWORD) {
    // SQL Server Authentication
    config.user = process.env.MSSQL_USER;
    config.password = process.env.MSSQL_PASSWORD;
    console.log('[MSSQL] Using SQL Server Authentication');
} else {
    // Windows Authentication
    config.options.trustedConnection = true;
    console.log('[MSSQL] Using Windows Authentication');
}

let pool;
async function getPool() {
    if (!pool) {
        pool = await sql.connect(config);
        console.log('[MSSQL] Connection pool established');
    }
    return pool;
}

// Manual refresh capability (SQL Server Agent handles automated scheduling)
async function refreshAllViews() {
    try {
        const pool = await getPool();
        const result = await pool.request().execute('oneroster12.sp_refresh_all');
        console.log('[MSSQL] OneRoster data refreshed manually');
        return result;
    } catch (error) {
        console.error('[MSSQL] Manual refresh error:', error);
        throw error;
    }
}

async function refreshSingleView(endpoint) {
    try {
        const pool = await getPool();
        const procedureName = `oneroster12.sp_refresh_${endpoint}`;
        const result = await pool.request().execute(procedureName);
        console.log(`[MSSQL] ${endpoint} refreshed manually`);
        return result;
    } catch (error) {
        console.error(`[MSSQL] Manual refresh error for ${endpoint}:`, error);
        throw error;
    }
}

// No scheduling function - SQL Server Agent handles this
function initializeMSSQLConnection() {
    console.log('[MSSQL] Using SQL Server Agent for automated refresh scheduling');
    console.log('[MSSQL] Daily refresh job: "OneRoster 1.2 Daily Refresh" at 2:00 AM');
}

module.exports = { 
    getPool, 
    refreshAllViews, 
    refreshSingleView, 
    initializeMSSQLConnection 
};