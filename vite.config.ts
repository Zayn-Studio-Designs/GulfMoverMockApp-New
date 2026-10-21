import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

// Audio files in public/assets/audio may contain characters that vite's dev URL handling
// cannot route (notably '#': the percent-encoded path is decoded and then split at the '#',
// so the default static middleware never finds the file and the SPA fallback answers HTML).
// The production build copies the files verbatim into dist/ and real static hosts decode
// %23 correctly, so only the development server needs this small rescue plugin.
const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(PROJECT_ROOT, 'public', 'assets', 'audio');

const AUDIO_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
}

function audioRescueMiddleware(server: ViteDevServer) {
  server.middlewares.use((req, res, next) => {
    const raw = (req.url || '').split('?')[0];
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
    if (!decoded || !decoded.startsWith('/assets/audio/') || !decoded.includes('#')) return next();
    const name = decoded.slice('/assets/audio/'.length);
    if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.')) return next();
    const file = path.join(AUDIO_DIR, name);
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', AUDIO_TYPES[path.extname(file).toLowerCase()] || 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    createReadStream(file).pipe(res);
  });
}

/** Dev-only plugin: serves public audio files whose filenames contain '#'. */
const audioRescue: Plugin = {
  name: 'gulf-mover-audio-rescue',
  configureServer: (server) => audioRescueMiddleware(server),
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), audioRescue],
  server: {
    port: 3000,
  },
  build: {
    rollupOptions: {
      input: {
        main: './index.html',
        presentation: './presentation.html'
      }
    }
  },
});
