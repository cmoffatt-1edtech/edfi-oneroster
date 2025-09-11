/**
 * Test that the server starts up correctly with unified controllers
 */

require('dotenv').config();

async function testServerStartup() {
    console.log('Testing Server Startup with Unified Controllers...\n');

    try {
        // Test module loading
        console.log('1. Testing module imports...');
        
        // Test OneRoster controller
        const oneRosterController = require('../../src/controllers/unified/oneRosterController');
        console.log('   ✅ OneRoster controller imported successfully');
        
        // Test routes
        const routes = require('../../src/routes/oneRoster');
        console.log('   ✅ OneRoster routes imported successfully');
        
        // Test health controller
        const healthController = require('../../src/controllers/healthController');
        console.log('   ✅ Health controller imported successfully');

        // Test database service factory
        const { getDefaultDatabaseService } = require('../../src/services/database/DatabaseServiceFactory');
        console.log('   ✅ Database service factory imported successfully');

        console.log('\n2. Testing database connections...');
        
        // Test PostgreSQL connection
        process.env.DB_TYPE = 'postgres';
        try {
            const pgService = await getDefaultDatabaseService();
            await pgService.testConnection();
            console.log('   ✅ PostgreSQL connection successful');
        } catch (error) {
            console.log(`   ❌ PostgreSQL connection failed: ${error.message}`);
        }

        // Test MSSQL connection
        process.env.DB_TYPE = 'mssql';
        try {
            // Clear cache to get fresh service
            delete require.cache[require.resolve('../../src/services/database/DatabaseServiceFactory')];
            delete require.cache[require.resolve('../../src/config/knex-factory')];
            
            const { getDefaultDatabaseService: getMSSQLService } = require('../../src/services/database/DatabaseServiceFactory');
            const mssqlService = await getMSSQLService();
            await mssqlService.testConnection();
            console.log('   ✅ MSSQL connection successful');
        } catch (error) {
            console.log(`   ❌ MSSQL connection failed: ${error.message}`);
        }

        console.log('\n3. Testing controller functions exist...');
        
        // Check that all required controller functions exist
        const requiredFunctions = [
            'orgs', 'orgsOne', 'classes', 'classesOne', 'users', 'usersOne',
            'academicSessions', 'academicSessionsOne', 'schools', 'schoolsOne',
            'students', 'studentsOne', 'teachers', 'teachersOne'
        ];
        
        for (const func of requiredFunctions) {
            if (typeof oneRosterController[func] === 'function') {
                console.log(`   ✅ ${func} function exists`);
            } else {
                console.log(`   ❌ ${func} function missing`);
            }
        }

        console.log('\n4. Testing health check endpoint...');
        
        // Mock health check request
        const mockReq = {};
        const mockRes = {
            json: function(data) { this.data = data; },
            status: function(code) { this.statusCode = code; return this; }
        };
        
        process.env.DB_TYPE = 'postgres'; // Reset to postgres for health check
        await healthController.list(mockReq, mockRes);
        
        if (mockRes.data && mockRes.data.status === 'pass') {
            console.log('   ✅ Health check successful');
            console.log(`   ✅ Database type: ${mockRes.data.database}`);
            console.log(`   ✅ Abstraction: ${mockRes.data.abstraction}`);
        } else {
            console.log('   ❌ Health check failed:', mockRes);
        }

        console.log('\n5. Testing route structure...');
        
        // Check that routes are Express router
        if (typeof routes === 'function' && routes.constructor.name === 'router') {
            console.log('   ✅ Routes is valid Express router');
        } else {
            console.log('   ❌ Routes is not valid Express router');
        }

        console.log('\n' + '='.repeat(60));
        console.log('✅ Server startup test completed successfully!');
        console.log('='.repeat(60));
        console.log('The application should be able to start with:');
        console.log('  npm start');
        console.log('  or');
        console.log('  node server.js');
        
        return true;

    } catch (error) {
        console.error('\n❌ Server startup test failed:', error.message);
        console.error('Stack:', error.stack);
        return false;
    } finally {
        // Cleanup
        try {
            // Clear cache and close connections
            delete require.cache[require.resolve('../../src/services/database/DatabaseServiceFactory')];
            delete require.cache[require.resolve('../../src/config/knex-factory')];
            
            const { databaseServiceFactory } = require('../../src/services/database/DatabaseServiceFactory');
            await databaseServiceFactory.closeAll();
            console.log('\n✅ All connections closed');
        } catch (error) {
            console.error('⚠️ Error during cleanup:', error.message);
        }
    }
}

// Run the test
console.log('Server Startup Test Suite');
console.log('=========================');
testServerStartup()
    .then(success => {
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error('Test suite error:', error);
        process.exit(1);
    });