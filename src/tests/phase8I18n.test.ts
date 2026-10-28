// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { I18N } from '../i18n/translations';

/** Every Phase 8 key referenced by the UI must exist in English AND Arabic (Arabic script). */
const root = path.resolve(__dirname, '..');
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const full = path.join(dir, f);
    if (statSync(full).isDirectory()) return f === 'tests' ? [] : files(full);
    return /\.(tsx?|ts)$/.test(f) ? [full] : [];
  });
}
const source = files(root).map(f => readFileSync(f, 'utf8')).join('\n');
const staticKeys = [...new Set([...source.matchAll(/['"`](p8[A-Za-z0-9]+)['"`]/g)].map(m => m[1]))];
const families: Record<string, string[]> = {
  p8Bk_: ['reserved', 'pending_payment', 'paid', 'cancelled', 'refunded', 'rescheduled', 'expired'],
  p8Pay_: ['unpaid', 'pending', 'paid', 'on_account', 'refunded', 'partially_refunded'],
  p8Min_: ['awaiting_minimum', 'threshold_met', 'below_minimum_after_deadline', 'proceed_below_minimum'],
  p8Gate_: ['open', 'not_ready', 'master_not_go', 'clearance_pending', 'sailing_suspended', 'sailing_cancelled', 'not_found'],
  p8PStatus_: ['initiated', 'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'expired', 'cancelled', 'requires_review'],
  p8Inv_: ['issued', 'partially_paid', 'paid', 'credited', 'void'],
  p8Rf_: ['pending_review', 'approved', 'rejected', 'processing', 'succeeded', 'failed'],
  p8Ev_: ['created', 'amended', 'cancelled', 'rescheduled', 'paid', 'refunded', 'terms_accepted', 'expired', 'payment_failed', 'payment_review', 'refund_requested', 'no_show', 'ticket_revoked', 'sailing_decision', 'invoiced'],
  p8Vat_: ['not_configured', 'exclusive', 'inclusive', 'exempt', 'zero_rated'],
  p8Sail_: ['open', 'closed', 'suspended', 'cancelled'],
  p8Cat_: ['general', 'equipment', 'spare_parts', 'provisions', 'documents', 'dangerous_goods', 'other'],
  p8Safety_: ['pending', 'accepted', 'refused', 'not_applicable'],
  p8Quote_: ['indicative', 'approved', 'superseded'],
  p5_: ['approved', 'scheduled', 'delivered', 'confirmed', 'completed', 'cancelled', 'safety_accepted', 'safety_refused', 'quoted'],
  p5Field_: ['weight_kg', 'volume_cbm', 'category', 'handling', 'hazardous'],
  p4Scan_: ['boarded', 'already_boarded', 'not_found', 'wrong_sailing', 'cancelled', 'sailing_cancelled', 'not_ready', 'payment_required', 'master_not_go', 'clearance_pending', 'sailing_suspended', 'revoked', 'no_show'],
};
const familyKeys = Object.entries(families).flatMap(([p, vs]) => vs.map(v => `${p}${v}`));
const navShort = ['p8NavSailings', 'p8NavFinance', 'p8NavReports', 'p8NavSystem', 'p8NavCompanyAccount', 'p8NavPrivacy'].map(k => `${k}Short`);

describe('Phase 8 translations', () => {
  it('finds the Phase 8 keys used by the interface', () => {
    expect(staticKeys.length).toBeGreaterThan(200);
  });
  it.each([...staticKeys, ...familyKeys, ...navShort])('%s has English and Arabic text', key => {
    expect(I18N.en[key], `missing English for ${key}`).toBeTruthy();
    expect(I18N.ar[key], `missing Arabic for ${key}`).toBeTruthy();
    expect(I18N.ar[key]).toMatch(/[؀-ۿ]/);
  });
  it('keeps placeholders identical in both languages', () => {
    for (const key of staticKeys) {
      const ph = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join();
      expect(ph(I18N.ar[key] ?? ''), key).toBe(ph(I18N.en[key] ?? ''));
    }
  });
});
