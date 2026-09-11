/**
 * The single place Chromium is launched.
 *
 * Every PDF in this app — game reports, opponent dossiers, opening repertoires,
 * invoices — used to call `puppeteer.launch({ headless: true })` directly, with
 * no `args`. That works on a developer's Mac and **fails on every one of them in
 * production**: the deployment image is `node:22-bookworm-slim` with no `USER`
 * directive, so the process runs as root, and Chromium's setuid sandbox refuses
 * to start as root. The failure had never been seen because PDF generation had
 * only ever run locally.
 *
 * `--no-sandbox` is safe here and only here: the only HTML this browser ever
 * loads is `page.setContent()` of markup this codebase generated itself. It
 * never navigates to a URL, never renders user-supplied HTML, and the container
 * is the security boundary. Do not reuse this helper to render untrusted pages.
 *
 * `--disable-dev-shm-usage` is the other container classic: Docker gives /dev/shm
 * 64 MB by default and Chromium will crash mid-render on a large document without
 * it.
 *
 * `PUPPETEER_EXECUTABLE_PATH` points at a Chromium the image already has, and is
 * read explicitly rather than left to Puppeteer's own env handling so that the
 * dependency is visible in this file. The production image installs Debian's
 * `chromium` package and sets `PUPPETEER_SKIP_DOWNLOAD`, because Puppeteer's
 * postinstall fetches ~200 MB from Google's storage and takes the entire
 * `npm ci` — and therefore the whole deploy — down with it when that fetch is
 * slow or blocked. It did exactly that on the first production build.
 *
 * Unset (a developer's machine), this is `undefined` and Puppeteer uses the copy
 * it downloaded for itself. Nothing changes locally.
 */
import puppeteer, { type Browser } from "puppeteer";

export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}
