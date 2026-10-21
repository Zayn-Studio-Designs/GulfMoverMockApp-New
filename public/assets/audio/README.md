# Boot sound — how to replace it

The device boot sequence reads one small manifest to know which file to play:

```
public/assets/audio/boot-sound.json
```

The manifest's current file name points at the sonic logo:

```json
{ "file": "ATCO_Marine_sonic_lo_#2-1792505560465.mp3" }
```

**To replace the sound** (no application code changes needed):

1. Drop the new audio file into `public/assets/audio/` (mp3 / wav / ogg / m4a / aac / flac).
2. Edit `boot-sound.json` so `file` is the exact file name (`.DS_Store`, `README.md` and any
   non-audio entries are ignored automatically; relative paths outside the folder are refused).
3. Restart/refresh — the presentation picks it up on the next boot.

Behaviour:

- One `Audio` element is reused for every replay, paused and rewound first, so no overlapping
  playback and no stacked instances.
- Sound can be muted/enabled from the presentation toolbar toggle; the choice is stored in
  localStorage under `gm-pres-boot-sound`.
- If the browser holds playback back (autoplay policy before any user interaction), a gentle
  hint appears near the bottom of the presentation and the sound button gets a small attention
  dot — one click on it enables the sound for the session.
- If the manifest is missing or points at nothing usable, the boot completes silently; nothing
  breaks. The manifest is re-read on the next boot after a failed attempt.

Keep this folder clean: anything other than real audio files plus this README and the manifest
is ignored. The genuine recordings remain property of ATCO Marine — do not substitute other
sounds in the product.
