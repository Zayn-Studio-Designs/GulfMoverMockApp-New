// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Least-privilege guard for internal (`_*`) RPC helpers.
 *
 * Every `public._*` function is an internal building block (pricing, terms
 * lookup, refund plumbing, triggers). None of them may be directly callable
 * through PostgREST: at the end of the migration chain, none of the
 * client-facing roles (`public`, `anon`, `authenticated`) may hold EXECUTE.
 *
 * Method: migrations are processed in chronological filename order; each
 * file's comment-free SQL is scanned for `GRANT EXECUTE` / `REVOKE` on
 * `public._*` functions (single- and multi-function statements, dynamic
 * `format('revoke/grant ...')` loops are treated as unknown and reported).
 * Grants add roles, revokes remove them, per function — so a later GRANT
 * after an earlier REVOKE is correctly detected as re-exposure.
 *
 * Intentionally unsupported forms (fail loudly, not silently):
 * - `ALTER DEFAULT PRIVILEGES` (not used by any migration today — the test
 *   scans for it and fails if one appears, so nobody can silently widen
 *   future-function grants).
 * - Dynamic `format('grant execute …')` loops over `_*` functions (none
 *   today; reported as unknown rather than assumed safe).
 * - Grants via role membership (e.g. granting to a role that `authenticated`
 *   inherits) — out of scope for a source parser; the PostgreSQL catalog
 *   check on a live stack is the authority.
 *
 * This is a regression guard, NOT a proof of the database ACL. The real
 * privilege check is a catalog query on a live stack (see
 * docs/launch/phase10-verification-results.md — blocked without Docker).
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');
const CLIENT_ROLES = ['public', 'anon', 'authenticated'];

interface GrantEvent {
  kind: 'grant' | 'revoke';
  functions: string[];
  roles: string[];
}

/** Strip `--` line comments and `/* … *\/` blocks so grants inside comments are ignored. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

export function migrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

/** Parse one comment-free migration body into an ordered event list. */
export function parseGrantEvents(body: string): { events: GrantEvent[]; unknown: string[] } {
  const events: GrantEvent[] = [];
  const unknown: string[] = [];
  const fnRe = /public\.(_[a-z0-9_]+)\s*\(/gi;
  // NOTE: GRANT uses TO, REVOKE uses FROM — both must match, otherwise
  // later GRANTs are invisible and re-exposure goes undetected.
  const stmtRe = /(grant\s+execute|revoke\s+(?:all|[a-z,\s]+))\s+on\s+function\s+([^;]+?)\s+(?:from|to)\s+([^;]+?);/gi;
  for (const m of body.matchAll(stmtRe)) {
    const fns = [...m[2].matchAll(fnRe)].map(f => f[1].toLowerCase());
    const roles = m[3].toLowerCase().split(/[^a-z_]+/).filter(Boolean);
    if (fns.length === 0) continue; // grant/revoke on non-`_*` functions: not our concern
    events.push({ kind: /^grant/i.test(m[1]) ? 'grant' : 'revoke', functions: fns, roles });
  }
  // Dynamic `execute format('grant|revoke … public.%s …', f)` loops: resolve
  // them when the iterated array is a literal list of signatures in the same
  // body. Only entries that could name a `_*` helper matter; a loop over an
  // all-non-underscore array is provably irrelevant and skipped. Anything
  // else (variable array, unresolvable) is reported as unknown.
  for (const m of body.matchAll(/foreach\s+\w+\s+in\s+array\s+array\[([\s\S]*?)\]\s*loop[\s\S]*?execute\s+format\(\s*'((?:revoke|grant)[^']*)'/gi)) {
    const arrayBody = m[1];
    const isRevoke = /^revoke/i.test(m[2]);
    const targetsUnderscore = /(^|[^a-z0-9_])_[a-z0-9_]*\s*\(/.test(arrayBody);
    if (targetsUnderscore) {
      const fns = [...arrayBody.matchAll(/'\s*(_[a-z0-9_]+)\s*\(/gi)].map(f => f[1].toLowerCase());
      const roles = isRevoke
        ? /from\s+([a-z_,\s]+)'\s*,/.test(m[2]) ? /from\s+([a-z_,\s]+)/.exec(m[2])![1].split(/[^a-z_]+/).filter(Boolean) : []
        : /to\s+([a-z_,\s]+)/.test(m[2]) ? /to\s+([a-z_,\s]+)/.exec(m[2])![1].split(/[^a-z_]+/).filter(Boolean) : [];
      if (fns.length > 0 && roles.length > 0) events.push({ kind: isRevoke ? 'revoke' : 'grant', functions: fns, roles });
      else unknown.push(`unresolvable ${isRevoke ? 'revoke' : 'grant'} loop over _* names`);
    }
    // else: array provably contains no `_*` helper — irrelevant, skip.
  }
  return { events, unknown };
}

/** Replay ordered events: grants add, revokes remove, per function. */
export function finalClientRoles(events: GrantEvent[]): Map<string, Set<string>> {
  const state = new Map<string, Set<string>>();
  // PostgreSQL default: a new function is executable by PUBLIC (hence all
  // client roles) until revoked.
  const ensure = (fn: string) => {
    if (!state.has(fn)) state.set(fn, new Set(CLIENT_ROLES));
    return state.get(fn)!;
  };
  for (const e of events) {
    for (const fn of e.functions) {
      const roles = ensure(fn);
      for (const r of e.roles) {
        if (e.kind === 'grant') roles.add(r);
        else roles.delete(r);
      }
    }
  }
  return state;
}

/** Full pipeline over an ordered list of (already comment-stripped) SQL bodies. */
export function auditBodies(bodies: string[]): { exposed: string[]; unknown: string[] } {
  // Any `ALTER DEFAULT PRIVILEGES` anywhere fails the audit loudly: it can
  // silently widen grants for future functions and this parser does not model it.
  const withAdp = bodies.filter(b => /alter\s+default\s+privileges/i.test(b));
  if (withAdp.length > 0) throw new Error('ALTER DEFAULT PRIVILEGES is not modelled — review manually');
  // Seed with every defined `_*` helper (PostgreSQL default for a new
  // function is executable-by-PUBLIC, so a helper with no statements at all
  // is exposed — the old union-of-revokes approach missed this).
  const defined = new Set<string>();
  for (const body of bodies) {
    for (const m of body.matchAll(/function\s+public\.(_[a-z0-9_]+)\s*\(/gi)) {
      defined.add(m[1].toLowerCase());
    }
  }
  const events: GrantEvent[] = [];
  const unknown: string[] = [];
  for (const body of bodies) {
    const parsed = parseGrantEvents(body);
    events.push(...parsed.events);
    unknown.push(...parsed.unknown);
  }
  const state = finalClientRoles(events);
  for (const fn of defined) if (!state.has(fn)) state.set(fn, new Set(CLIENT_ROLES));
  const exposed = [...state.entries()]
    .filter(([, roles]) => CLIENT_ROLES.some(r => roles.has(r)))
    .map(([fn]) => fn)
    .sort();
  return { exposed, unknown };
}

function repoBodies(): string[] {
  return migrationFiles().map(f => stripSqlComments(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')));
}

describe('internal RPC helpers are not client-callable', () => {
  test('chronological audit: no public._* helper is client-callable at chain end', () => {
    const bodies = repoBodies();
    expect(bodies.length).toBeGreaterThan(0);
    const defined = new Set<string>();
    for (const body of bodies) {
      for (const m of body.matchAll(/function\s+public\.(_[a-z0-9_]+)\s*\(/gi)) {
        defined.add(m[1].toLowerCase());
      }
    }
    expect(defined.size).toBeGreaterThan(0);
    const { exposed, unknown } = auditBodies(bodies);
    expect(unknown).toEqual([]);
    expect(exposed).toEqual([]);
  });

  test('synthetic: a later GRANT after an earlier REVOKE is detected', () => {
    const early = stripSqlComments(`create function public._synth_regress() returns void as $$ begin end; $$;
      revoke all on function public._synth_regress() from public, anon, authenticated;`);
    const late = stripSqlComments(`-- re-created by a later feature migration
      create or replace function public._synth_regress() returns void as $$ begin end; $$;
      grant execute on function public._synth_regress() to authenticated;`);
    expect(auditBodies([early, late]).exposed).toEqual(['_synth_regress']);
    // And without the late grant it stays clean.
    expect(auditBodies([early]).exposed).toEqual([]);
  });

  test('synthetic: multi-role revoke, single-role revoke, and late-introduced helper', () => {
    // Revoked in stages across migrations (public+anon first, authenticated later).
    const m1 = stripSqlComments(`revoke all on function public._synth_staged() from public, anon;`);
    const m2 = stripSqlComments(`revoke all on function public._synth_staged() from authenticated;`);
    expect(auditBodies([m1, m2]).exposed).toEqual([]);
    expect(auditBodies([m1]).exposed).toEqual(['_synth_staged']);
    // Helper introduced in a later migration with no revoke at all.
    const late = stripSqlComments(`create function public._synth_late() returns void as $$ begin end; $$;`);
    expect(auditBodies([m1, m2, late]).exposed).toContain('_synth_late');
  });

  test('grants inside comments are not parsed as permissions', () => {
    const body = stripSqlComments(`-- grant execute on function public._synth_comment() to authenticated;
/* revoke all on function public._synth_comment() from public, anon; */
create function public._synth_comment() returns void as $$ begin end; $$;`);
    const { events } = parseGrantEvents(body);
    expect(events).toEqual([]);
  });
});
