// MySQL / MariaDB access. All times are stored as UTC DATETIME(3).
import mysql from 'mysql2/promise';

import { config } from './config.js';
import { MIGRATIONS } from './schema.js';

export type Row = mysql.RowDataPacket;
export type Pool = mysql.Pool;

let pool: Pool | null = null;

export function db(): Pool {
  pool ??= mysql.createPool({
    ...config.db,
    connectionLimit: 8,
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: false,
    supportBigNumbers: true,
    multipleStatements: false,
  });
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}

export async function all<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await db().query<Row[]>(sql, params);
  return rows as T[];
}

export async function one<T = Row>(sql: string, params: unknown[] = []): Promise<T | null> {
  return (await all<T>(sql, params))[0] ?? null;
}

/** Runs an INSERT/UPDATE/DELETE and returns the number of affected rows. */
export async function run(sql: string, params: unknown[] = []): Promise<number> {
  const [res] = await db().query<mysql.ResultSetHeader>(sql, params);
  return res.affectedRows;
}

export async function migrate() {
  await db().query('CREATE TABLE IF NOT EXISTS schema_version (version INT NOT NULL PRIMARY KEY, applied_at DATETIME(3) NOT NULL)');
  const done = new Set((await all<{ version: number }>('SELECT version FROM schema_version')).map((r) => r.version));
  for (const [i, statements] of MIGRATIONS.entries()) {
    const version = i + 1;
    if (done.has(version)) continue;
    for (const sql of statements) await db().query(sql);
    await run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [version, new Date()]);
    console.log(`Database migrated to version ${version}`);
  }
}

/** JSON columns come back as strings on MariaDB and as objects on MySQL. */
export function json<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  return v as T;
}
