import pool from '../lib/altus-db.js';

export async function initSkillLibrarySchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS altus_skills (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL UNIQUE,
      title VARCHAR(255) NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      source VARCHAR(20) NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ
    )
  `);
}

export async function searchSkills({ query, limit = 10 } = {}) {
  if (!process.env.DATABASE_URL) {
    return { success: false, exit_reason: 'config_error' };
  }

  const effectiveLimit = Math.min(Math.max(limit, 1), 50);
  const { rows } = await pool.query(
    `SELECT name, title, description, tags, source
       FROM altus_skills
      WHERE deleted_at IS NULL
        AND (
          $1::text IS NULL OR
          name ILIKE '%' || $1 || '%' OR
          title ILIKE '%' || $1 || '%' OR
          description ILIKE '%' || $1 || '%'
        )
      ORDER BY name ASC
      LIMIT $2`,
    [query || null, effectiveLimit],
  );

  return { success: true, skills: rows, count: rows.length };
}
