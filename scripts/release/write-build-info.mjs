#!/usr/bin/env node
// Writes dist/build-info.json after `vite build`: a static health/version endpoint for
// monitoring (no secrets, no environment values).
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
if (!existsSync('dist')) { console.error('dist/ missing: run the build first'); process.exit(1); }
let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const info = { status: 'ok', app: 'gulf-mover', commit, release: process.env.VITE_RELEASE || commit, builtAt: new Date().toISOString() };
writeFileSync('dist/build-info.json', `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: ${info.release}`);
