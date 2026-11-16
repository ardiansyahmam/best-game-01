// Entry program for best-game-01 (Node 22, standard library only).
//
// What it does, in three steps:
//   1. Takes the game folder and the screenshots folder that sit next to
//      this file and copies them into the hand-in directory.
//   2. Asks the vendored make.fun library to summarise those copied files
//      into a dossier the judge reads.
//   3. Writes that dossier next to them as dossier.json.
//
// The hand-in directory is /output when the grader runs it. While we are
// developing, MAKEFUN_OUTPUT_DIR can point somewhere else instead:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
//
// The caps below mirror the competition's own limits, so a local run fails
// in the same places the scorer would refuse the entry: at most 4
// screenshots of 256 KiB each, at most 993 files / 48 MiB under game/, no
// path under game/ longer than 1000 bytes, and 160 KiB of source text in
// the dossier.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The folder this file lives in: the repository root.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// Where the finished entry goes. The grader provides /output; a local run
// overrides it through the environment.
const handInDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(handInDir, { recursive: true });

// game/ is the whole playable game: plain static files, no build step.
cpSync(join(repoRoot, 'game'), join(handInDir, 'game'), { recursive: true });

// screenshots/ holds 3 or 4 real renders of the game; the first file by
// name is the cover the judge sees largest. It may not exist yet while the
// game is still being built, so only copy it when it is there.
mkdirSync(join(handInDir, 'screenshots'), { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), join(handInDir, 'screenshots'), {
    recursive: true,
  });
}

// The dossier is derived from the copied files, never from the source
// folders, so what the judge reads is exactly what was handed in.
writeFileSync(
  join(handInDir, 'dossier.json'),
  buildDossier(handInDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

console.log(`entry written to ${handInDir}`);
