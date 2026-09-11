/**
 * Chromium launches, renders, and closes — and nothing bypasses the shared helper.
 *
 *   npx tsx --env-file=.env.local scripts/verifyPdfLaunch.ts
 *
 * This exists because of a bug that could only ever have been found in
 * production: all three PDF renderers called `puppeteer.launch({headless:true})`
 * with no args, and the deployment image runs as root, where Chromium's setuid
 * sandbox refuses to start. Reports, dossiers, opening repertoires and invoices
 * would all have died on the first production render.
 *
 * The grep assertion is the important half. A passing render proves today's code
 * works; the grep is what stops the next renderer from reintroducing a bare
 * launch and shipping it unnoticed.
 *
 * No database, no network.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { launchBrowser } from "../src/lib/pdf/launch";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

/** Every .ts/.tsx file under src/, excluding the helper itself. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

async function main() {
  console.log("1. Chromium launches with the container-safe flags");
  const browser = await launchBrowser();
  let pdf: Buffer;
  try {
    const page = await browser.newPage();
    await page.setContent("<h1>KCA launch check</h1>", { waitUntil: "load" });
    pdf = Buffer.from(await page.pdf({ format: "A4" }));
  } finally {
    await browser.close();
  }
  check("a PDF buffer was produced", pdf.length > 0, `got ${pdf.length} bytes`);
  check("it is a real PDF (%PDF magic bytes)", pdf.subarray(0, 4).toString() === "%PDF",
    `got ${JSON.stringify(pdf.subarray(0, 4).toString())}`);
  check("browser closed without throwing", true);

  console.log("2. Nothing bypasses the shared helper");
  const helper = path.normalize("src/lib/pdf/launch.ts");
  const offenders = sourceFiles("src")
    .filter((f) => path.normalize(f) !== helper)
    .filter((f) => /puppeteer\.launch\s*\(/.test(readFileSync(f, "utf8")));
  check("no bare puppeteer.launch( outside src/lib/pdf/launch.ts",
    offenders.length === 0, offenders.join(", "));

  const helperSrc = readFileSync(helper, "utf8");
  check("the helper passes --no-sandbox", helperSrc.includes("--no-sandbox"));
  check("the helper passes --disable-dev-shm-usage", helperSrc.includes("--disable-dev-shm-usage"));

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
}

main()
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
