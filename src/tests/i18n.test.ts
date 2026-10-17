import { describe, expect, test } from 'vitest';
import { I18N } from '../i18n/translations';
import { translateKey, translateText } from '../i18n/translate';

describe('translation tables', () => {
  test('every English key has an Arabic translation', () => {
    const missing = Object.keys(I18N.en).filter(k => !I18N.ar[k]);
    expect(missing).toEqual([]);
  });

  test('Arabic values contain Arabic script', () => {
    const latinOnly = Object.entries(I18N.ar).filter(([, v]) => !/[؀-ۿ]/.test(v));
    expect(latinOnly).toEqual([]);
  });

  test('key lookup falls back to English, then the key', () => {
    expect(translateKey('ar', 'navBook')).toBe('حجز نقل بحري');
    expect(translateKey('en', 'navBook')).toBe('Book Transfer');
    expect(translateKey('ar', 'no-such-key')).toBe('no-such-key');
  });
});

describe('free-text translation', () => {
  test('English mode returns the text unchanged', () => {
    expect(translateText('en', 'Approved Anchorage A (Demo)')).toBe('Approved Anchorage A (Demo)');
  });

  test('placeholder destinations and statuses are translated', () => {
    expect(translateText('ar', 'Approved Anchorage A (Demo)')).toBe('منطقة الرسو المعتمدة أ (تجريبي)');
    expect(translateText('ar', 'Payment recorded (demo)')).toBe('تم تسجيل الدفع (تجريبي)');
  });

  test('booking references and identifiers are left intact', () => {
    expect(translateText('ar', 'GM-DEMO-0248')).toBe('GM-DEMO-0248');
    expect(translateText('ar', 'MR-DEMO-01')).toBe('MR-DEMO-01');
  });
});
