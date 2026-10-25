// Boot sound asset selection.
//
// The horn file lives in `public/assets/audio/`. To replace the sound, drop a new file there
// and point `boot-sound.json` at it — no application code changes needed:
//
//   { "file": "atco-boot-sound.mp3" }
//
// Use a URL-safe name (letters, digits, dots, dashes): characters such as '#' make static servers
// split the path, so the audio is fetched as HTML and the boot falls silent. Everything else
// (README.md, .DS_Store, backups) is ignored automatically. If the manifest is missing or
// unusable the boot simply plays silently; nothing ever breaks.

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

/**
 * The single-file download has no server to fetch the manifest or the audio from, so its build
 * embeds the sound as a data URL on window.__gmBootSoundUrl. Only audio data URLs are accepted;
 * the normal app never sets it and keeps using boot-sound.json.
 */
export function embeddedBootSoundUrl(): string | null {
  const v = (window as unknown as { __gmBootSoundUrl?: unknown }).__gmBootSoundUrl;
  return typeof v === 'string' && v.startsWith('data:audio/') ? v : null;
}
