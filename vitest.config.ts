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
    css: true,
    reporters: ['verbose'],
    coverage: {
      reporter: ['text', 'json', 'html']
    }
  }
})