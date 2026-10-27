// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const migration = readFileSync('supabase/migrations/20261028100000_access_hardening.sql', 'utf8');
const config = readFileSync('supabase/config.toml', 'utf8');
describe('Phase 4 static security/configuration regression (not database execution)', () => {
  it.each(['has_platform_role', 'has_org_role', 'active_org_ids'])('%s checks profile suspension in a fixed-path definer', name => {
    const body = migration.split(`function public.${name}(`)[1].split('$$;')[0];
    expect(body).toContain("set search_path = ''");
    expect(body).toContain("p.status = 'suspended'");
    expect(body).toContain('auth.uid()');
  });
  it('blocks self-reactivation through the old profile-status trigger', () => {
    expect(migration).toContain("not public.has_platform_role('{super_admin}')");
    expect(migration).toContain('revoke execute on function public.guard_profile_status()');
  });
  it('replaces table-wide scheduling SELECT with explicit non-actor columns', () => {
    expect(migration).toContain('revoke select on public.vessels, public.routes, public.sailings from authenticated');
    const grants = migration.split('\n').filter(l => l.startsWith('grant select(')).join('\n');
    expect(grants).not.toMatch(/created_by|updated_by/);
  });
  it('clean reset skips the manual seed requiring existing fictional users, with correct filename', () => {
    const seed = config.split('[db.seed]')[1].split('[db.network_restrictions]')[0];
    expect(seed).toContain('enabled = false');
    expect(seed).toContain('sql_paths = ["./seed_demo.sql"]');
  });
  it('requires email confirmation and explicitly permits the local password recovery callbacks', () => {
    expect(config.split('[auth.email]')[1].split('[auth.email.smtp]')[0]).toContain('enable_confirmations = true');
    expect(config).toContain('http://localhost:4317/auth/reset-callback');
    expect(config).toContain('http://127.0.0.1:3000/auth/reset-callback');
  });
});
