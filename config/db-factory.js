const dbType = process.env.DB_TYPE || 'postgres';

if (dbType === 'mssql') {
    module.exports = require('./db-mssql');
} else {
    module.exports = require('./db');
}