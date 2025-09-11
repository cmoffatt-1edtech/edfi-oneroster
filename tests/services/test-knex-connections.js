/**
 * Test Knex.js connections for PostgreSQL and MSSQL
 */

require('dotenv').config();
const { databaseServiceFactory } = require('../../src/services/database/DatabaseServiceFactory');
const { knexManager } = require('../../src/config/knex-factory');

async function testConnections() {
  console.log('Testing Knex.js Database Connections...\n');

  try {
    // Test all database connections
    console.log('1. Testing database connections...');
    const connectionResults = await databaseServiceFactory.testAllConnections();
    
    console.log('\nConnection Test Results:');
    console.log('├── PostgreSQL:', connectionResults.postgres.success ? '✅ Success' : '❌ Failed');
    if (connectionResults.postgres.error) {
      console.log('│   Error:', connectionResults.postgres.error);
    }
    
    console.log('└── MSSQL:', connectionResults.mssql.success ? '✅ Success' : '❌ Failed');
    if (connectionResults.mssql.error) {
      console.log('    Error:', connectionResults.mssql.error);
    }

    // Test individual Knex instances
    console.log('\n2. Testing individual Knex instances...');
    
    // Test PostgreSQL Knex
    if (connectionResults.postgres.success) {
      console.log('\nTesting PostgreSQL Knex instance:');
      try {
        const pgKnex = knexManager.getInstance('postgres');
        const pgResult = await pgKnex.raw('SELECT version() as version');
        console.log('✅ PostgreSQL raw query successful');
        console.log('   Version info:', pgResult.rows[0].version.substring(0, 50) + '...');
        
        // Test schema query
        const schemaTest = await pgKnex.withSchema('oneroster12').table('orgs').count('* as count');
        console.log('✅ Schema query successful - orgs table has', schemaTest[0].count, 'records');
      } catch (error) {
        console.log('❌ PostgreSQL Knex test failed:', error.message);
      }
    }

    // Test MSSQL Knex
    if (connectionResults.mssql.success) {
      console.log('\nTesting MSSQL Knex instance:');
      try {
        const mssqlKnex = knexManager.getInstance('mssql');
        const mssqlResult = await mssqlKnex.raw('SELECT @@VERSION as version');
        console.log('✅ MSSQL raw query successful');
        console.log('   Version info:', mssqlResult[0].version.substring(0, 80) + '...');
        
        // Test schema query
        const schemaTest = await mssqlKnex.withSchema('oneroster12').table('orgs').count('* as count');
        console.log('✅ Schema query successful - orgs table has', schemaTest[0].count, 'records');
      } catch (error) {
        console.log('❌ MSSQL Knex test failed:', error.message);
      }
    }

    // Test query building (without execution)
    console.log('\n3. Testing query building capabilities...');
    
    if (connectionResults.postgres.success || connectionResults.mssql.success) {
      const testKnex = connectionResults.postgres.success 
        ? knexManager.getInstance('postgres')
        : knexManager.getInstance('mssql');
      
      // Test basic query building
      const basicQuery = testKnex.withSchema('oneroster12')
        .table('orgs')
        .select('sourcedId', 'name', 'type')
        .where('status', 'active')
        .orderBy('name')
        .limit(5);
        
      console.log('✅ Basic query built successfully');
      console.log('   SQL:', basicQuery.toString());
      
      // Test complex query building
      const complexQuery = testKnex.withSchema('oneroster12')
        .table('users')
        .select('sourcedId', 'username', 'role')
        .where('status', 'active')
        .andWhere('role', '!=', 'administrator')
        .orderBy('username')
        .limit(10)
        .offset(0);
        
      console.log('✅ Complex query built successfully');
      console.log('   SQL:', complexQuery.toString());
    }

    // Get factory stats
    console.log('\n4. Factory statistics:');
    const stats = databaseServiceFactory.getStats();
    
    const successCount = (connectionResults.postgres.success ? 1 : 0) + 
                        (connectionResults.mssql.success ? 1 : 0);
    
    console.log(`\n${'='.repeat(50)}`);
    console.log('TEST SUMMARY');
    console.log('='.repeat(50));
    console.log(`Databases tested: 2`);
    console.log(`Successful connections: ${successCount}`);
    console.log(`Services created: ${stats.totalServices}`);
    
    if (successCount === 2) {
      console.log('\n🎉 All Knex.js connections working successfully!');
      return true;
    } else if (successCount === 1) {
      console.log('\n⚠️  One database connection failed, but we can proceed');
      return true;
    } else {
      console.log('\n❌ No database connections working');
      return false;
    }

  } catch (error) {
    console.error('\n❌ Fatal error during connection testing:', error.message);
    console.error('Stack:', error.stack);
    return false;
  } finally {
    // Cleanup
    try {
      await databaseServiceFactory.closeAll();
      console.log('\n✅ All connections closed successfully');
    } catch (error) {
      console.error('⚠️  Error closing connections:', error.message);
    }
  }
}

// Run the tests
console.log('Knex.js Connection Test Suite');
console.log('==============================');
testConnections()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
  });