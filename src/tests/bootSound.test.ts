import { describe, expect, test } from 'vitest';
import { bootSoundUrl, selectBootSoundFile } from '../presentation/bootSound';

describe('boot sound manifest', () => {
  test('selects the configured audio file', () => {
    expect(selectBootSoundFile({ file: 'ATCO_Marine_sonic_lo_#2-1792505560465.mp3' }))
      .toBe('ATCO_Marine_sonic_lo_#2-1792505560465.mp3');
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
    expect(bootSoundUrl('ATCO_Marine_sonic_lo_#2-1792505560465.mp3'))
      .toBe('/assets/audio/ATCO_Marine_sonic_lo_%232-1792505560465.mp3');
    expect(bootSoundUrl('simple.mp3')).toBe('/assets/audio/simple.mp3');
  });
});
