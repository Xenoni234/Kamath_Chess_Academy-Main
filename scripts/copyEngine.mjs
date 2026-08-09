/**
 * Copies the Stockfish WASM builds we serve to the browser out of node_modules
 * and into `public/engine/`.
 *
 * The `stockfish` package unpacks to ~250 MB because it ships the full NNUE
 * nets, so it is a devDependency and only the two *lite* flavours (~7 MB each)
 * are copied. `public/engine/` is gitignored — this script runs from `predev`
 * and `prebuild`, so a fresh clone gets the files after `npm install`.
 *
 * Each `.js` loader resolves its `.wasm` sibling from its own URL, so the two
 * files of a flavour must stay in the same directory.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(root, "node_modules", "stockfish", "bin");
const targetDir = path.join(root, "public", "engine");

// Multi-threaded first (needs a cross-origin-isolated page), then the
// single-threaded fallback. Keep in sync with src/lib/engine/select.ts.
const FILES = [
  "stockfish-18-lite.js",
  "stockfish-18-lite.wasm",
  "stockfish-18-lite-single.js",
  "stockfish-18-lite-single.wasm",
];

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(sourceDir))) {
    console.error(
      `[copyEngine] ${path.relative(root, sourceDir)} not found. Run \`npm install\` first.`,
    );
    process.exit(1);
  }

  await fs.mkdir(targetDir, { recursive: true });

  let copied = 0;
  let skipped = 0;

  for (const file of FILES) {
    const from = path.join(sourceDir, file);
    const to = path.join(targetDir, file);

    if (!(await exists(from))) {
      console.error(`[copyEngine] missing source file: ${file}`);
      process.exit(1);
    }

    // Skip when the destination already matches, so `npm run dev` stays fast.
    const [sourceStat, targetStat] = await Promise.all([
      fs.stat(from),
      exists(to).then((ok) => (ok ? fs.stat(to) : null)),
    ]);

    if (targetStat && targetStat.size === sourceStat.size) {
      skipped += 1;
      continue;
    }

    await fs.copyFile(from, to);
    copied += 1;
  }

  console.log(`[copyEngine] ${copied} copied, ${skipped} up to date -> public/engine/`);
}

main().catch((error) => {
  console.error("[copyEngine] failed:", error);
  process.exit(1);
});
