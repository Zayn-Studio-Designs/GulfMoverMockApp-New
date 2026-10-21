// Boot sound asset selection.
//
// The horn file lives in `public/assets/audio/`. To replace the sound, drop a new file there
// and point `boot-sound.json` at it — no application code changes needed:
//
//   { "file": "ATCO_Marine_sonic_lo_#2-1792505560465.mp3" }
//
// Everything else (README.md, .DS_Store, backups) is ignored automatically. If the manifest
// is missing or unusable the boot simply plays silently; nothing ever breaks.

export const BOOT_SOUND_MANIFEST_URL = '/assets/audio/boot-sound.json';

/**
 * Picks the configured audio file from a parsed manifest. Accepts the documented shape
 * `{ file: "name.mp3" }`. Filenames that would not resolve to audio (README, dotfiles,
 * manifests, folders) are refused so a stray edit can't make the app fetch junk as audio.
 */
export function selectBootSoundFile(manifest: unknown): string | null {
  const file = (manifest as { file?: unknown } | null)?.file;
  if (typeof file !== 'string') return null;
  const name = file.trim();
  if (!name || name.includes('/') || name.includes('\\')) return null; // never leave the folder
  if (/(^|\.)(readme(\.md)?|boot-sound\.json)$/i.test(name)) return null;
  if (/^\./.test(name)) return null; // .DS_Store and friends
  if (!/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name)) return null; // only real audio types
  return name;
}

/** Public URL for an audio file in the boot-sound folder (# and spaces included, safely cited). */
export function bootSoundUrl(file: string): string {
  return '/assets/audio/' + encodeURIComponent(file);
}
