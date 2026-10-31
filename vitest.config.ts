import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Bound concurrent jsdom/React workers on developer laptops; unbounded workers
    // starved existing async UI assertions during the Phase 4 baseline run.
    maxWorkers: 2,
    minWorkers: 1,
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    // Tests never inherit a developer's .env / .env.local (which may point at a hosted
    // project): every test starts in demo mode with no backend and stubs what it needs.
    env: {
      VITE_APP_MODE: 'demo', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', VITE_AUTH_RESET_REDIRECT_URL: '',
      VITE_PAYMENTS_FUNCTION_URL: '', VITE_ERROR_REPORTING_URL: '', VITE_PRODUCTION_PROJECT_REF: '', VITE_ALLOW_REMOTE_DATABASE: '',
    },
    css: true,
    reporters: ['verbose'],
    coverage: {
      reporter: ['text', 'json', 'html']
    }
  }
})