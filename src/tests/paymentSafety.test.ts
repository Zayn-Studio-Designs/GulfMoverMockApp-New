// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Payment-safety invariants, enforced at source level so they hold without a
 * live database. The money rules:
 *  - the browser never prices a payment (no amount parameter flows client→server);
 *  - provider results are applied only through service-role-only RPCs;
 *  - live mode has a server-side kill-switch;
 *  - verification and refunds are staff-gated.
 */
const MIGRATIONS_DIR = path.resolve(__dirname, '../../supabase/migrations');
const SRC_DIR = path.resolve(__dirname, '..');

const migrations = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(f => readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

const service = (p: string) => readFileSync(path.join(SRC_DIR, p), 'utf8');

describe('payment safety invariants', () => {
  test('begin_checkout takes no amount: the server prices from the booking fare', () => {
    const defs = migrations()
      .flatMap(sql => [...sql.matchAll(/function\s+public\.begin_checkout\(([^)]*)\)/gi)])
      .map(m => m[1].toLowerCase());
    expect(defs.length).toBeGreaterThan(0);
    for (const params of defs) {
      expect(params).not.toMatch(/amount|total|price|halala/);
    }
    const body = migrations().join('\n');
    expect(body).toMatch(/values\s*\(\s*p_booking_id,\s*v_b\.total_halala,\s*'SAR'/);
  });

  test('the browser checkout call sends identity only, never money', () => {
    const rpcCall = service('lib/phase8Service.ts');
    const m = /rpcRows\('begin_checkout',\s*\{([^}]*)\}/.exec(rpcCall);
    expect(m).toBeTruthy();
    expect(m![1].toLowerCase()).not.toMatch(/amount|total|price|halala/);
    expect(m![1]).toMatch(/p_booking_id.*p_method.*p_idempotency_key/s);
  });

  test('provider-result RPCs are service-role only (no browser path to forge results)', () => {
    const sql = migrations().join('\n');
    for (const fn of ['apply_payment_result', 'attach_provider_checkout', 'apply_refund_result']) {
      const grants = [...sql.matchAll(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\([^;]*?\\)\\s+to\\s+([^;]+?);`, 'gi'))];
      expect(grants.length, fn).toBeGreaterThan(0);
      for (const g of grants) {
        expect(g[1].toLowerCase(), fn).not.toContain('authenticated');
        expect(g[1].toLowerCase(), fn).not.toContain('anon');
        expect(g[1].toLowerCase(), fn).toContain('service_role');
      }
    }
  });

  test('live payments have a server-side kill-switch', () => {
    const sql = migrations().join('\n');
    expect(sql).toMatch(/payments\.live_enabled/);
    expect(sql).toMatch(/payments_not_enabled: live payments are not activated/);
  });

  test('verification and refunds are staff-gated, never caller-asserted', () => {
    const sql = migrations().join('\n');
    const verifyBody = /function\s+public\.verify_payment[\s\S]*?has_platform_role\('\{super_admin,operations,finance\}'\)/.test(sql);
    const refundBody = /function\s+public\.request_refund[\s\S]*?_require_staff\('\{super_admin,finance\}'\)/.test(sql);
    expect(verifyBody).toBe(true);
    expect(refundBody).toBe(true);
  });
});
