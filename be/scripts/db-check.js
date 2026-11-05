// Throwaway Phase 0 connectivity check. Usage: node scripts/db-check.js
import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
try {
  await client.connect();
  const v = await client.query('SELECT version();');
  console.log('VERSION:', v.rows[0].version);
  const p = await client.query("SELECT * FROM pg_available_extensions WHERE name='postgis';");
  console.log('POSTGIS:', p.rows.length ? JSON.stringify(p.rows[0]) : 'NOT AVAILABLE');
  const tz = await client.query("SELECT now() AT TIME ZONE 'Asia/Kolkata' AS ist_now;");
  console.log('IST NOW:', tz.rows[0].ist_now);
} catch (e) {
  console.error('DB CHECK FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
