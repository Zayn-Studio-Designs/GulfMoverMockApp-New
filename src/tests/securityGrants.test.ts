// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Least-privilege guard for internal (`_*`) RPC helpers.
 *
 * Every `public._*` function is an internal building block (pricing, terms
 * lookup, refund plumbing, triggers). None of them may be directly callable
 * through PostgREST: each must be revoked from `public, anon, authenticated`
 * (and `service_role` except where the server itself needs it — the test
 * requires at least the three client-facing roles).
 *
 * This is a source-level test: it parses every migration in order, so a new
 * migration that (re)creates an internal helper without the matching revoke
 * fails the suite without needing a live database. Hosted exposure is
 * additionally covered by the Supabase security advisor.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');

function migrationSources(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
}

describe('internal RPC helpers are not client-callable', () => {
  test('every public._* function is revoked from public, anon and authenticated', () => {
    const sources = migrationSources();
    expect(sources.length).toBeGreaterThan(0);

    const defined = new Set<string>();
    for (const sql of sources) {
      for (const m of sql.matchAll(/function\s+public\.(_[a-z0-9_]+)\s*\(/gi)) {
        defined.add(m[1].toLowerCase());
      }
    }
    expect(defined.size).toBeGreaterThan(0);

    // A revoke may cover several functions in one statement, and the
    // revocation may arrive in stages across migrations (e.g. Phase 7 revoked
    // public/anon/service_role, Phase 10 adds authenticated), so accumulate
    // the union of revoked roles per function.
    const revokedRoles = new Map<string, Set<string>>();
    for (const sql of sources) {
      for (const m of sql.matchAll(/revoke\s+all\s+on\s+function\s+([^;]+?)\s+from\s+([^;]+?);/gi)) {
        const roles = m[2].toLowerCase().split(/[^a-z_]+/).filter(Boolean);
        for (const f of m[1].matchAll(/public\.(_[a-z0-9_]+)\s*\(/gi)) {
          const name = f[1].toLowerCase();
          if (!revokedRoles.has(name)) revokedRoles.set(name, new Set());
          for (const r of roles) revokedRoles.get(name)!.add(r);
        }
      }
    }

    const exposed = [...defined].filter(fn => {
      const roles = revokedRoles.get(fn) ?? new Set<string>();
      return !roles.has('public') || !roles.has('anon') || !roles.has('authenticated');
    });
    expect(exposed).toEqual([]);
  });

  test('the terms-lookup helper used by booking is not client-callable', () => {
    const sources = migrationSources();
    const revoke = sources.some(sql =>
      /revoke\s+all\s+on\s+function\s+[^;]*public\._reserve_booking_terms[^;]*from\s+[^;]*authenticated[^;]*;/i.test(sql),
    );
    expect(revoke).toBe(true);
  });
});
