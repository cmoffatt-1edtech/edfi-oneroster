require('dotenv').config();

/**
 * Controller Factory
 * Selects the appropriate controllers based on the database type (DB_TYPE environment variable)
 */

let oneRosterOneController;
let oneRosterManyController;

// Load controllers based on database type
if (process.env.DB_TYPE === 'mssql') {
    console.log('Loading MSSQL controllers...');
    oneRosterOneController = require('./mssql/oneRosterOneController');
    oneRosterManyController = require('./mssql/oneRosterManyController');
} else {
    console.log('Loading PostgreSQL controllers...');
    oneRosterOneController = require('./oneRosterOneController');
    oneRosterManyController = require('./oneRosterManyController');
}

module.exports = {
    oneRosterOneController,
    oneRosterManyController
};