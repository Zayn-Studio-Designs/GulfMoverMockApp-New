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
 * client-facing roles (`public`, `anon`, `authenticated`) may hold EXECUTE
 * on any overload.
 *
 * Method: migrations run in chronological filename order through a SINGLE
 * left-to-right pass. Each comment-free body is scanned once by a combined
 * pattern that matches ordinary `GRANT`/`REVOKE … ON FUNCTION` statements
 * and dynamic `foreach … execute format('grant|revoke …')` loops at their
 * actual text positions, so events keep true statement order within and
 * across migrations. Supported statement forms:
 * - `GRANT EXECUTE ON FUNCTION … TO …`
 * - `GRANT ALL [PRIVILEGES] ON FUNCTION … TO …` (for functions ALL = EXECUTE)
 * - `REVOKE ALL|EXECUTE ON FUNCTION … FROM …`
 * - multi-function statements (`f(a), f(b), …`), schema-qualified names.
 * Events are keyed by function SIGNATURE (`name(args)`, whitespace-normalised),
 * so overloads are never merged by bare name.
 *
 * Intentionally unsupported forms (fail loudly, not silently):
 * - `ALTER DEFAULT PRIVILEGES` (not used by any migration today).
 * - A permission statement without an argument list when the name has no
 *   defined overload yet (nothing to resolve it against).
 * - A dynamic loop whose array cannot be statically resolved.
 * - Grants via role membership (a role `authenticated` inherits) or
 *   ownership subtleties — out of scope for a source parser; the PostgreSQL
 *   catalog check on a live stack is the authority.
 *
 * This is a regression guard, NOT a proof of the database ACL.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');
const CLIENT_ROLES = ['public', 'anon', 'authenticated'];

interface GrantEvent {
  kind: 'grant' | 'revoke';
  /** Signature keys: `name(normalised args)`. */
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

/**
 * Normalise an argument list to TYPES ONLY (`p_booking_id uuid` → `uuid`).
 * PostgreSQL matches GRANT/REVOKE ON FUNCTION by type signature; parameter
 * names are irrelevant, and migrations often revoke with bare types
 * (`(uuid)`) while definitions carry names (`(p_booking_id uuid)`).
 * Multi-word types (`timestamp with time zone`) and `DEFAULT` clauses are
 * handled; anything unrecognised is kept verbatim (fail-safe: a mismatch
 * shows up as exposed, never as silently clean).
 */
const TYPE_START = /^(smallint|integer|int2?|int4?|int8|bigint|decimal|numeric|real|float4?|float8?|double|precision|serial|bigserial|money|character|varchar|char|text|bytea|timestamp|date|time|interval|boolean|bool|jsonb?|uuid|inet|cidr|macaddr|bit|varbit|oid|reg[a-z]*|any\w*|void|trigger|record|[a-z_]+\.)/i;
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of args) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim() !== '' || parts.length > 0) parts.push(cur);
  return parts;
}
export function normArgs(args: string): string {
  return splitTopLevel(args)
    .map(a => {
      const s = a.trim().replace(/\s+default\s+.*$/i, '').trim();
      const m = /^([A-Za-z_][\w$]*)\s+(.+)$/.exec(s);
      if (m && !TYPE_START.test(m[1]) && TYPE_START.test(m[2])) return m[2].trim();
      return s;
    })
    .join(',')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
const sigKey = (name: string, args: string) => `${name.toLowerCase()}(${normArgs(args)})`;
const UNDERSCORE_FN = /public\.(_[a-z0-9_]+)\s*\(([^()]*)\)/gi;

/**
 * Single left-to-right pass over one comment-free body. Ordinary permission
 * statements and dynamic format-loops are matched in true text order.
 */
export function parseGrantEvents(body: string): { events: GrantEvent[]; unknown: string[] } {
  const events: GrantEvent[] = [];
  const unknown: string[] = [];
  const re = new RegExp(
    'foreach\\s+\\w+\\s+in\\s+array\\s+array\\[(?<arr>[\\s\\S]*?)\\]\\s*loop[\\s\\S]*?' +
    "execute\\s+format\\(\\s*'(?<fmt>(?:revoke|grant)[^']*)'" +
    '|(?<stmt>(?:grant\\s+(?:execute|all(?:\\s+privileges)?)|revoke\\s+(?:all(?:\\s+privileges)?|[a-z,\\s]+))' +
    '\\s+on\\s+function\\s+(?<targets>[^;]+?)\\s+(?:from|to)\\s+(?<roles>[^;]+?);)',
    'gi',
  );
  for (const m of body.matchAll(re)) {
    if (m.groups?.arr !== undefined) {
      // Dynamic loop: the iterated array is literal and precedes the format
      // call, so resolving it here preserves statement order.
      const isRevoke = /^revoke/i.test(m.groups.fmt);
      const arrayBody: string = m.groups.arr;
      if (!/(^|[^a-z0-9_])_[a-z0-9_]*\s*\(/.test(arrayBody)) continue; // provably no _* helper
      const fns = [...arrayBody.matchAll(/'\s*([a-z0-9_]+)\s*\(([^()]*)\)/gi)]
        .filter(f => f[1].startsWith('_'))
        .map(f => sigKey(f[1], f[2]));
      const roleSrc = m.groups.fmt;
      const roleClause = isRevoke ? /\bfrom\s+([a-z_,\s]+)/i.exec(roleSrc) : /\bto\s+([a-z_,\s]+)/i.exec(roleSrc);
      const roles = roleClause ? roleClause[1].toLowerCase().split(/[^a-z_]+/).filter(Boolean) : [];
      if (fns.length > 0 && roles.length > 0) events.push({ kind: isRevoke ? 'revoke' : 'grant', functions: fns, roles });
      else unknown.push(`unresolvable ${isRevoke ? 'revoke' : 'grant'} format-loop`);
      continue;
    }
    const stmt = m.groups?.stmt ?? '';
    const isGrant = /^grant/i.test(stmt);
    const targets = m.groups?.targets ?? '';
    const roles = (m.groups?.roles ?? '').toLowerCase().split(/[^a-z_]+/).filter(Boolean);
    // Signature-qualified targets first.
    const fns = [...targets.matchAll(UNDERSCORE_FN)].map(f => sigKey(f[1], f[2]));
    if (fns.length > 0) {
      events.push({ kind: isGrant ? 'grant' : 'revoke', functions: fns, roles });
      continue;
    }
    // Bare `public._name` without an argument list: only resolvable against
    // already-defined overloads; otherwise it must fail loudly.
    const bare = [...targets.matchAll(/public\.(_[a-z0-9_]+)(?!\s*\()/gi)].map(f => f[1].toLowerCase());
    if (bare.length > 0) unknown.push(`bare-name ${isGrant ? 'grant' : 'revoke'} without signature: ${bare.join(',')}`);
  }
  return { events, unknown };
}

/** Replay ordered events: grants add, revokes remove, per signature key. */
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
  if (bodies.some(b => /alter\s+default\s+privileges/i.test(b))) {
    throw new Error('ALTER DEFAULT PRIVILEGES is not modelled — review manually');
  }
  // Seed with every defined `_*` signature: a helper with no permission
  // statement at all keeps the PostgreSQL PUBLIC-executable default.
  const defined = new Set<string>();
  for (const body of bodies) {
    for (const m of body.matchAll(/function\s+public\.(_[a-z0-9_]+)\s*\(([^()]*)\)/gi)) {
      defined.add(sigKey(m[1], m[2]));
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

const wrap = (sql: string) => stripSqlComments(sql);
const CREATE = (sig: string) => `create function public.${sig} returns void as $$ begin end; $$;`;

describe('internal RPC helpers are not client-callable', () => {
  test('chronological audit: no public._* helper is client-callable at chain end', () => {
    const bodies = repoBodies();
    expect(bodies.length).toBeGreaterThan(0);
    const { exposed, unknown } = auditBodies(bodies);
    expect(unknown).toEqual([]);
    expect(exposed).toEqual([]);
  });

  test('1. created then revoked stays clean; revoked then granted is detected', () => {
    expect(auditBodies([wrap(`${CREATE('_h1()')} revoke all on function public._h1() from public, anon, authenticated;`)]).exposed).toEqual([]);
    const late = wrap(`${CREATE('_h1()')} grant execute on function public._h1() to authenticated;`);
    expect(auditBodies([wrap(`${CREATE('_h1()')} revoke all on function public._h1() from public, anon, authenticated;`), late]).exposed)
      .toEqual(['_h1()']);
  });

  test('2/3. GRANT ALL PRIVILEGES after a revocation re-exposes', () => {
    const bodies = [
      wrap(`${CREATE('_h2(uuid)')} revoke all on function public._h2(uuid) from public, anon, authenticated;`),
      wrap(`grant all privileges on function public._h2(uuid) to authenticated;`),
    ];
    expect(auditBodies(bodies).exposed).toEqual(['_h2(uuid)']);
  });

  test('4/5. dynamic revoke then explicit grant, and vice versa, in true order', () => {
    const loopRevoke = `do $$ declare f text; begin foreach f in array array['_h3(uuid)'] loop ` +
      `execute format('revoke all on function public.%s from public, anon, authenticated', f); end loop; end $$;`;
    const explicitGrant = `grant execute on function public._h3(uuid) to authenticated;`;
    // Loop first, grant second → exposed (order preserved within/across bodies).
    expect(auditBodies([wrap(`${CREATE('_h3(uuid)')} ${loopRevoke}`), wrap(explicitGrant)]).exposed).toEqual(['_h3(uuid)']);
    // Grant first, loop-revoke second → clean.
    expect(auditBodies([wrap(`${CREATE('_h3(uuid)')} ${explicitGrant}`), wrap(loopRevoke)]).exposed).toEqual([]);
  });

  test('6/7. staged revokes clean up; a late helper with no revoke is exposed', () => {
    const m1 = wrap(`revoke all on function public._h4() from public, anon;`);
    const m2 = wrap(`revoke all on function public._h4() from authenticated;`);
    expect(auditBodies([m1, m2]).exposed).toEqual([]);
    expect(auditBodies([m1]).exposed).toEqual(['_h4()']);
    expect(auditBodies([m1, m2, wrap(CREATE('_h5(text)'))]).exposed).toContain('_h5(text)');
  });

  test('8. permission statements inside comments are ignored', () => {
    const body = wrap(`-- grant execute on function public._h6() to authenticated;\n/* revoke all on function public._h6() from public, anon; */\n${CREATE('_h6()')}`);
    expect(parseGrantEvents(body).events).toEqual([]);
  });

  test('9. overloads are tracked separately, never merged by name', () => {
    const bodies = [wrap(
      `${CREATE('_h7(uuid)')} ${CREATE('_h7(text)')}` +
      `revoke all on function public._h7(uuid), public._h7(text) from public, anon, authenticated;` +
      `grant execute on function public._h7(text) to authenticated;`,
    )];
    // Only the text overload is exposed; the uuid overload must not be
    // merged into it, nor hidden by it.
    expect(auditBodies(bodies).exposed).toEqual(['_h7(text)']);
  });

  test('9b. revokes with bare types match definitions with parameter names', () => {
    // PostgreSQL matches by type signature; the migration convention revokes
    // `(uuid)` while definitions carry `(p_booking_id uuid)`.
    const bodies = [wrap(
      `create function public._h9(p_booking_id uuid, p_reason text default null) returns void as $$ begin end; $$;` +
      `revoke all on function public._h9(uuid, text) from public, anon, authenticated;`,
    )];
    expect(auditBodies(bodies).exposed).toEqual([]);
    expect(normArgs('p_booking_id uuid, p_reason text DEFAULT null')).toBe('uuid,text');
    expect(normArgs('p_at timestamptz')).toBe('timestamptz');
  });

  test('10. unsupported forms fail loudly instead of passing silently', () => {
    expect(() => auditBodies([wrap(`alter default privileges for role postgres grant execute on functions to anon; `)]))
      .toThrow(/ALTER DEFAULT PRIVILEGES/);
    const bare = parseGrantEvents(wrap(`revoke all on function public._h8 from public, anon;`));
    expect(bare.unknown.length).toBeGreaterThan(0);
  });
});
