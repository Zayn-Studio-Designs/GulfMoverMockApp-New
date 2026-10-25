import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { bootSoundUrl, selectBootSoundFile } from '../presentation/bootSound';

const AUDIO_DIR = path.join(process.cwd(), 'public', 'assets', 'audio');
const REPLACEMENT = 'atco-boot-sound.mp3';

describe('boot sound manifest', () => {
  test('selects the configured audio file', () => {
    expect(selectBootSoundFile({ file: REPLACEMENT })).toBe(REPLACEMENT);
    expect(selectBootSoundFile({ file: ' horn-two.wav ' })).toBe('horn-two.wav');
  });

  test('refuses non-audio entries instead of fetching junk', () => {
    expect(selectBootSoundFile({ file: 'README.md' })).toBeNull();
    expect(selectBootSoundFile({ file: 'readme.md' })).toBeNull();
    expect(selectBootSoundFile({ file: '.DS_Store' })).toBeNull();
    expect(selectBootSoundFile({ file: 'boot-sound.json' })).toBeNull();
    expect(selectBootSoundFile({ file: 'notes.txt' })).toBeNull();
    expect(selectBootSoundFile({ file: '' })).toBeNull();
    expect(selectBootSoundFile(null)).toBeNull();
    expect(selectBootSoundFile({})).toBeNull();
    expect(selectBootSoundFile('horn.mp3')).toBeNull();
  });

  test('never points outside the audio folder', () => {
    expect(selectBootSoundFile({ file: '../index.html' })).toBeNull();
    expect(selectBootSoundFile({ file: 'a\\b.mp3' })).toBeNull();
  });

  test('builds a usable public URL for awkward filenames', () => {
    expect(bootSoundUrl(REPLACEMENT)).toBe('/assets/audio/atco-boot-sound.mp3');
    expect(bootSoundUrl('horn two.mp3')).toBe('/assets/audio/horn%20two.mp3');
  });

  // The shipped manifest must name a real file: a replaced recording is only picked up when this
  // pair matches, and the boot stays silent (by design) when it does not.
  test('the shipped manifest names an audio file that exists in the folder', () => {
    const manifest = JSON.parse(readFileSync(path.join(AUDIO_DIR, 'boot-sound.json'), 'utf8'));
    expect(selectBootSoundFile(manifest)).toBe(REPLACEMENT);
    expect(existsSync(path.join(AUDIO_DIR, REPLACEMENT))).toBe(true);
  });

  // '#' and similar characters are decoded and split by static servers (dev server, `vite preview`,
  // plain hosts), which serves HTML instead of audio and silences the boot. The file must stay
  // portable so no server-side workaround is needed.
  test('the shipped filename is URL-safe', () => {
    expect(REPLACEMENT).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(REPLACEMENT.includes('#')).toBe(false);
    expect(bootSoundUrl(REPLACEMENT)).toBe('/assets/audio/' + REPLACEMENT);
  });
});
