require('dotenv').config();

exports.list = async (req, res) => {
  try {
    const dbType = process.env.DB_TYPE === 'mssql' ? 'MSSQLSERVER' : 'POSTGRESQL';
    
    if (process.env.DB_TYPE === 'mssql') {
      // MSSQL connection test
      const { getPool } = require('../../config/db-mssql');
      const pool = await getPool();
      await pool.request().query('SELECT 1');
    } else {
      // PostgreSQL connection test
      const db = require('../../config/db');
      await db.pool.query('SELECT 1');
    }
    
    res.json({ 
      status: "pass",
      database: dbType
    });
  } catch (err) {
    console.error(err);
    res.status(503).json({ status: "fail", error: "database unreachable" });
  }
};