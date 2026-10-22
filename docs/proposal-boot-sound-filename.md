# Proposal (not applied): rename the boot sound file

Status: **awaiting approval**. Nothing has been renamed and `vite.config.ts` is unchanged on branch 0-2.

## Current situation
- The ATCO sonic logo is stored as `public/assets/audio/ATCO_Marine_sonic_lo_#2-1792505560465.mp3`.
- `boot-sound.json` names that file. `bootSound.ts` builds the URL with `encodeURIComponent`, so the `#` becomes `%23`.
- The Vite development server decodes `%23` back to `#` and treats the rest as a page fragment. It therefore cannot find the file on its own.
- `vite.config.ts` contains a dev-only middleware (`audioRescue`, about 45 lines) that serves audio files whose names contain `#`.

## Proposal
Rename the file to a URL-safe name, for example `atco-marine-sonic-logo-2.mp3`, and update `boot-sound.json` to match. Then remove the `audioRescue` middleware from `vite.config.ts`.

## Benefits
- Removes custom server code that only exists to work around the file name. That is less to maintain, and nothing can behave differently between development and production.
- `#` in file names is fragile outside Vite as well: in `file://` URLs, some static hosts and CDNs, zip tools, and the single-file presentation downloads. A plain name works everywhere.
- The app code does not change. The manifest design already supports replacing the file by editing `boot-sound.json`.

## Risks
- **Brand asset provenance.** The current name appears to be the original name from ATCO's delivery. Renaming it loses that link unless we record the original name. A note in `public/assets/audio/README.md` would cover this.
- **Other references.** Anyone with links or scripts that use the old name would need updating. A search of this repository finds the name in four files:
  - `public/assets/audio/boot-sound.json`
  - `public/assets/audio/README.md`
  - the comments in `src/presentation/bootSound.ts`
  - `src/tests/bootSound.test.ts`, which would need its expected name updated

  `vite.config.ts` matches any name containing `#`, not this specific name.
- **Caching.** Browsers that cached the old URL simply fetch the new one. There is no functional risk.
- **Not yet verified.** I have not checked whether `vite preview` and the production host need the workaround today. The `vite.config.ts` comment says production hosts decode `%23` correctly. I would verify this in the browser as part of the change.

## Recommended steps if approved
1. `git mv` the file to the new name, without re-encoding the audio. Its bytes must stay identical; verify with a checksum.
2. Update `boot-sound.json`, the README (recording the original file name) and the comments in `bootSound.ts`.
3. Remove `audioRescue` from `vite.config.ts`.
4. Verify that the boot sound plays in `npm run dev`, `npm run build && npm run preview`, and the presentation, with sound toggled on and off.
