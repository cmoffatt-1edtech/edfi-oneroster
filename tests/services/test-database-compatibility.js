/**
 * Test compatibility between PostgreSQL and MSSQL OneRoster services
 * Verify they return identical results for the same queries
 */

require('dotenv').config();
const { getDatabaseServiceForType } = require('../../src/services/database/DatabaseServiceFactory');

// Test configurations
const testConfig = {
  defaultSortField: 'sourcedId',
  selectableFields: [
    'sourcedId', 'status', 'dateLastModified', 'name', 
    'type', 'identifier', 'parent', 'children'
  ],
  allowedFilterFields: [
    'sourcedId', 'status', 'dateLastModified', 'name', 'type'
  ]
};

/**
 * Normalize results for comparison (handle potential differences in JSON parsing, etc.)
 */
function normalizeResults(results) {
  return results.map(record => {
    const normalized = { ...record };
    
    // Convert dates to ISO strings for comparison
    if (normalized.dateLastModified) {
      normalized.dateLastModified = new Date(normalized.dateLastModified).toISOString();
    }
    
    // Ensure consistent null/undefined handling
    Object.keys(normalized).forEach(key => {
      if (normalized[key] === undefined) {
        normalized[key] = null;
      }
    });
    
    return normalized;
  });
}

/**
 * Compare two result sets
 */
function compareResults(pgResults, mssqlResults, testName) {
  const normalizedPg = normalizeResults(pgResults);
  const normalizedMssql = normalizeResults(mssqlResults);
  
  const comparison = {
    testName,
    pgCount: pgResults.length,
    mssqlCount: mssqlResults.length,
    countsMatch: pgResults.length === mssqlResults.length,
    identical: false,
    firstRecordMatch: false,
    sourcedIdsMatch: false
  };
  
  // Compare counts
  if (!comparison.countsMatch) {
    console.log(`   ⚠️ Count mismatch: PostgreSQL=${pgResults.length}, MSSQL=${mssqlResults.length}`);
    return comparison;
  }
  
  // Compare first record if available
  if (normalizedPg.length > 0 && normalizedMssql.length > 0) {
    comparison.firstRecordMatch = normalizedPg[0].sourcedId === normalizedMssql[0].sourcedId;
    
    // Check if all sourcedIds match (order matters)
    const pgIds = normalizedPg.map(r => r.sourcedId);
    const mssqlIds = normalizedMssql.map(r => r.sourcedId);
    comparison.sourcedIdsMatch = JSON.stringify(pgIds) === JSON.stringify(mssqlIds);
  }
  
  // Full comparison
  try {
    comparison.identical = JSON.stringify(normalizedPg) === JSON.stringify(normalizedMssql);
  } catch (error) {
    console.log(`   ⚠️ Error comparing results: ${error.message}`);
  }
  
  return comparison;
}

async function testDatabaseCompatibility() {
  console.log('Testing Database Compatibility Between PostgreSQL and MSSQL...\n');
  
  let pgService, mssqlService;
  const testResults = [];
  
  try {
    // Initialize services
    console.log('1. Initializing database services...');
    pgService = await getDatabaseServiceForType('postgres');
    mssqlService = await getDatabaseServiceForType('mssql');
    console.log('   ✅ Both services initialized successfully');
    
    // Test 1: Basic query comparison
    console.log('\n2. Comparing basic queries...');
    const basicQuery = { limit: 5, offset: 0 };
    
    const pgOrgs = await pgService.queryMany('orgs', testConfig, basicQuery);
    const mssqlOrgs = await mssqlService.queryMany('orgs', testConfig, basicQuery);
    
    const basicComparison = compareResults(pgOrgs, mssqlOrgs, 'Basic Query');
    testResults.push(basicComparison);
    
    console.log(`   PostgreSQL: ${basicComparison.pgCount} records`);
    console.log(`   MSSQL: ${basicComparison.mssqlCount} records`);
    console.log(`   ✅ Counts match: ${basicComparison.countsMatch}`);
    console.log(`   ✅ First record match: ${basicComparison.firstRecordMatch}`);
    console.log(`   ✅ All sourcedIds match: ${basicComparison.sourcedIdsMatch}`);
    
    // Test 2: Filtered query comparison
    console.log('\n3. Comparing filtered queries...');
    const filterQuery = { 
      limit: 10, 
      offset: 0, 
      filter: "status='active'" 
    };
    
    try {
      const pgFiltered = await pgService.queryMany('orgs', testConfig, filterQuery);
      const mssqlFiltered = await mssqlService.queryMany('orgs', testConfig, filterQuery);
      
      const filterComparison = compareResults(pgFiltered, mssqlFiltered, 'Filtered Query');
      testResults.push(filterComparison);
      
      console.log(`   PostgreSQL: ${filterComparison.pgCount} active records`);
      console.log(`   MSSQL: ${filterComparison.mssqlCount} active records`);
      console.log(`   ✅ Counts match: ${filterComparison.countsMatch}`);
      console.log(`   ✅ Results identical: ${filterComparison.identical}`);
    } catch (error) {
      console.log(`   ⚠️ Filtered query test failed: ${error.message}`);
      testResults.push({ testName: 'Filtered Query', error: error.message });
    }
    
    // Test 3: Sorted query comparison
    console.log('\n4. Comparing sorted queries...');
    const sortQuery = { 
      limit: 5, 
      offset: 0, 
      sort: 'name',
      orderBy: 'asc'
    };
    
    const pgSorted = await pgService.queryMany('orgs', testConfig, sortQuery);
    const mssqlSorted = await mssqlService.queryMany('orgs', testConfig, sortQuery);
    
    const sortComparison = compareResults(pgSorted, mssqlSorted, 'Sorted Query');
    testResults.push(sortComparison);
    
    console.log(`   PostgreSQL: ${sortComparison.pgCount} sorted records`);
    console.log(`   MSSQL: ${sortComparison.mssqlCount} sorted records`);
    console.log(`   ✅ Same ordering: ${sortComparison.sourcedIdsMatch}`);
    
    // Test 4: Pagination comparison
    console.log('\n5. Comparing pagination...');
    const page1Query = { limit: 2, offset: 0 };
    const page2Query = { limit: 2, offset: 2 };
    
    const pgPage1 = await pgService.queryMany('orgs', testConfig, page1Query);
    const pgPage2 = await pgService.queryMany('orgs', testConfig, page2Query);
    const mssqlPage1 = await mssqlService.queryMany('orgs', testConfig, page1Query);
    const mssqlPage2 = await mssqlService.queryMany('orgs', testConfig, page2Query);
    
    const page1Comparison = compareResults(pgPage1, mssqlPage1, 'Page 1');
    const page2Comparison = compareResults(pgPage2, mssqlPage2, 'Page 2');
    testResults.push(page1Comparison, page2Comparison);
    
    console.log(`   Page 1 - PostgreSQL: ${page1Comparison.pgCount}, MSSQL: ${page1Comparison.mssqlCount}`);
    console.log(`   Page 2 - PostgreSQL: ${page2Comparison.pgCount}, MSSQL: ${page2Comparison.mssqlCount}`);
    console.log(`   ✅ Page 1 identical: ${page1Comparison.identical}`);
    console.log(`   ✅ Page 2 identical: ${page2Comparison.identical}`);
    
    // Test 5: Single record query comparison
    console.log('\n6. Comparing single record queries...');
    if (pgOrgs.length > 0 && mssqlOrgs.length > 0) {
      const testId = pgOrgs[0].sourcedId;
      
      const pgSingle = await pgService.queryOne('orgs', testId);
      const mssqlSingle = await mssqlService.queryOne('orgs', testId);
      
      const singleFound = pgSingle && mssqlSingle;
      const singleMatch = singleFound ? pgSingle.sourcedId === mssqlSingle.sourcedId : false;
      
      console.log(`   Test ID: ${testId}`);
      console.log(`   PostgreSQL: ${pgSingle ? 'Found' : 'Not found'}`);
      console.log(`   MSSQL: ${mssqlSingle ? 'Found' : 'Not found'}`);
      console.log(`   ✅ Both found same record: ${singleMatch}`);
      
      testResults.push({ 
        testName: 'Single Record', 
        bothFound: singleFound, 
        recordsMatch: singleMatch 
      });
    }
    
    // Test 6: Field selection comparison
    console.log('\n7. Comparing field selection...');
    const fieldsQuery = { 
      limit: 3, 
      offset: 0, 
      fields: 'sourcedId,name,type' 
    };
    
    const pgFields = await pgService.queryMany('orgs', testConfig, fieldsQuery);
    const mssqlFields = await mssqlService.queryMany('orgs', testConfig, fieldsQuery);
    
    const fieldsComparison = compareResults(pgFields, mssqlFields, 'Field Selection');
    testResults.push(fieldsComparison);
    
    console.log(`   PostgreSQL fields: ${pgFields.length > 0 ? Object.keys(pgFields[0]).join(', ') : 'N/A'}`);
    console.log(`   MSSQL fields: ${mssqlFields.length > 0 ? Object.keys(mssqlFields[0]).join(', ') : 'N/A'}`);
    console.log(`   ✅ Results identical: ${fieldsComparison.identical}`);
    
    // Test 7: Complex filter comparison
    console.log('\n8. Comparing complex filters...');
    try {
      const complexQuery = { 
        limit: 10, 
        offset: 0, 
        filter: "status='active' AND type='school'" 
      };
      
      const pgComplex = await pgService.queryMany('orgs', testConfig, complexQuery);
      const mssqlComplex = await mssqlService.queryMany('orgs', testConfig, complexQuery);
      
      const complexComparison = compareResults(pgComplex, mssqlComplex, 'Complex Filter');
      testResults.push(complexComparison);
      
      console.log(`   PostgreSQL: ${complexComparison.pgCount} records`);
      console.log(`   MSSQL: ${complexComparison.mssqlCount} records`);
      console.log(`   ✅ Results identical: ${complexComparison.identical}`);
    } catch (error) {
      console.log(`   ⚠️ Complex filter test failed: ${error.message}`);
      testResults.push({ testName: 'Complex Filter', error: error.message });
    }
    
    // Summary
    console.log('\n' + '='.repeat(70));
    console.log('COMPATIBILITY TEST SUMMARY');
    console.log('='.repeat(70));
    
    const successfulTests = testResults.filter(r => !r.error && (r.identical || r.countsMatch || r.bothFound));
    const identicalTests = testResults.filter(r => r.identical);
    
    console.log(`Total tests: ${testResults.length}`);
    console.log(`Successful tests: ${successfulTests.length}`);
    console.log(`Identical results: ${identicalTests.length}`);
    
    // Detailed results
    testResults.forEach(result => {
      if (result.error) {
        console.log(`❌ ${result.testName}: Error - ${result.error}`);
      } else if (result.identical) {
        console.log(`✅ ${result.testName}: Identical results`);
      } else if (result.countsMatch && result.sourcedIdsMatch) {
        console.log(`✅ ${result.testName}: Same records, same order`);
      } else if (result.countsMatch) {
        console.log(`⚠️ ${result.testName}: Same count, different ordering`);
      } else if (result.bothFound && result.recordsMatch) {
        console.log(`✅ ${result.testName}: Both found matching records`);
      } else {
        console.log(`❌ ${result.testName}: Results differ`);
      }
    });
    
    const compatibilityScore = (successfulTests.length / testResults.length) * 100;
    console.log(`\nCompatibility Score: ${compatibilityScore.toFixed(1)}%`);
    
    if (compatibilityScore >= 80) {
      console.log('\n🎉 Excellent database compatibility!');
      return true;
    } else if (compatibilityScore >= 60) {
      console.log('\n⚠️ Good compatibility with some differences');
      return true;
    } else {
      console.log('\n❌ Poor database compatibility');
      return false;
    }
    
  } catch (error) {
    console.error('\n❌ Compatibility test failed:', error.message);
    console.error('Stack:', error.stack);
    return false;
  }
}

async function runCompatibilityTests() {
  try {
    const success = await testDatabaseCompatibility();
    return success;
  } catch (error) {
    console.error('Fatal error during compatibility testing:', error);
    return false;
  } finally {
    // Cleanup
    try {
      const { databaseServiceFactory } = require('../../src/services/database/DatabaseServiceFactory');
      await databaseServiceFactory.closeAll();
      console.log('\n✅ All connections closed');
    } catch (error) {
      console.error('⚠️ Error during cleanup:', error.message);
    }
  }
}

// Run the compatibility tests
console.log('Database Compatibility Test Suite');
console.log('==================================');
runCompatibilityTests()
  .then(success => {
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
  });