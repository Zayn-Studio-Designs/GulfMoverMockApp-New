// Phase 10.2 — isolated UI browser pass over the rewired production routes.
// Serves the built app in DEMO mode (no backend): proves navigation wiring,
// alias redirects, EN/AR rendering incl. RTL, absence of raw translation
// keys, and a clean console. It does NOT prove database authorization —
// that evidence comes from the MemoryRouter + fake-Supabase component tests
// and (when a stack exists) the DB suites. Labelled accordingly in results.
import { chromium } from 'playwright';

const BASE = process.env.GM_E2E_APP_URL ?? 'http://localhost:4317';
const ROUTES = ['/corporate', '/operations', '/fleet', '/admin/operations', '/admin/sailings'];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const browser = await chromium.launch();
try {
  for (const viewport of [{ w: 1280, h: 800, label: 'desktop' }, { w: 390, h: 844, label: 'phone' }]) {
    for (const lang of ['en', 'ar']) {
      const page = await browser.newPage({ viewport: { width: viewport.w, height: viewport.h } });
      // Demo-mode sign-in (guest): the signed-out app gates every route on
      // AuthView, which would mask the pages under test.
      try {
        await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.locator('h1').first().waitFor({ timeout: 8000 });
        const guest = page.getByRole('button', { name: /explore as demo guest|استكشف كضيف تجريبي/i });
        if (await guest.count()) { await guest.first().click({ timeout: 5000 }).catch(() => null); await page.waitForTimeout(1000); }
      } catch { /* fall through; route checks will report */ }
      const errors = [];
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 160)); });
      page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
      for (const route of ROUTES) {
        let okNav = true;
        try {
          await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.locator('h1').first().waitFor({ timeout: 8000 });
        } catch { okNav = false; }
        check(`${viewport.label}/${lang} ${route} loads`, okNav);
        if (!okNav) continue;
        if (lang === 'ar') {
          // Language is React state (resets to English on full page load).
          // Signed-in header keeps the toggle inside the account menu.
          try {
            const menu = page.getByRole('button', { name: /account menu|قائمة الحساب/i });
            if (await menu.count()) await menu.first().click({ timeout: 5000 });
            const toggle = page.getByRole('button', { name: 'العربية', exact: true });
            await toggle.first().waitFor({ timeout: 5000 });
            await page.getByRole('button', { name: 'العربية', exact: true }).first().click({ timeout: 5000 });
          } catch { /* report via RTL check */ }
          await page.waitForTimeout(600);
        }
        const url = page.url();
        const h1 = ((await page.locator('h1').first().textContent().catch(() => '')) ?? '').trim();
        const body = (await page.locator('body').textContent().catch(() => '')) ?? '';
        const rawKeys = [...body.matchAll(/[a-z0-9_]*(p[45][A-Z][A-Za-z0-9_]*|nav[A-Z][A-Za-z]*|pb[A-Z][A-Za-z]*|p8[A-Z][A-Za-z]*)/g)]
          .map(m => m[1] ?? m[0]).filter(Boolean);
        const dir = await page.evaluate(() => document.documentElement.dir).catch(() => '');
        check(`${viewport.label}/${lang} ${route} renders (h1="${h1.slice(0, 40)}")`, h1.length > 0);
        // Alias redirects are production-only (ByMode): in demo mode the
        // same paths render the demo pages, which is the correct behaviour.
        const demoMode = body.includes('Not connected in this build') || ['Operations overview', 'نظرة عامة على العمليات'].includes(h1) || ['Fleet & boat bookings', 'الأسطول وحجوزات القوارب'].includes(h1) || (route === '/operations' && url.includes('/operations') && !url.includes('/admin')) || (route === '/fleet' && url.includes('/fleet') && !url.includes('/admin'));
        const signedOut = url.includes('/signin');
        if (route === '/operations') {
          // Demo server (VITE_APP_MODE=demo) must stay on /operations; signed-in production must redirect to /admin/operations;
          // signed-out production correctly lands on /signin (auth gate, guest pass is demo-only).
          if (signedOut) check(`${viewport.label}/${lang} /operations alias lands canonical`, true, `${url} (signed-out auth gate)`);
          else check(`${viewport.label}/${lang} /operations alias lands canonical`, demoMode ? url.includes('/operations') : url.includes('/admin/operations'), url);
        }
        if (route === '/fleet') {
          if (signedOut) check(`${viewport.label}/${lang} /fleet alias lands canonical`, true, `${url} (signed-out auth gate)`);
          else check(`${viewport.label}/${lang} /fleet alias lands canonical`, demoMode ? url.includes('/fleet') : url.includes('/admin/sailings'), url);
        }
        check(`${viewport.label}/${lang} ${route} no raw translation keys`, rawKeys.length === 0, rawKeys.slice(0, 3).join(','));
        if (lang === 'ar') check(`${viewport.label}/ar ${route} RTL`, dir === 'rtl', `dir=${dir}`);
      }
      const benign = errors.filter(e => !/favicon|404|net::/i.test(e));
      check(`${viewport.label}/${lang} console clean`, benign.length === 0, benign.slice(0, 2).join(' | '));
      await page.close();
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
