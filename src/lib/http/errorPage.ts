import { NextResponse } from "next/server";

/**
 * A readable page for a failed file download.
 *
 * The report and dossier download routes are reached by NAVIGATION — the dashboard links
 * straight at them — so returning `{ success:false, message:"…" }` put raw JSON on screen.
 * A student saw literally this in a browser tab:
 *
 *   {"success":false,"message":"This report's file has expired â€" check your email …"}
 *
 * mojibake included, because the JSON was served without a charset. The academy's users
 * are children; they get a sentence and a way back instead.
 *
 * Text is escaped, so a message may never carry markup. Keep the wording plain: say what
 * happened and what to do, and nothing about files, servers or expiry.
 */
function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function errorPage(options: {
  title: string;
  body: string;
  status: number;
  /** Where "go back" should lead. Defaults to the dashboard. */
  backHref?: string;
  backLabel?: string;
}) {
  const { title, body, status, backHref = "/dashboard", backLabel = "Go back" } = options;

  return new NextResponse(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#050505; color:#fff; padding:24px;
         font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
  .box { max-width:26rem; text-align:center; background:#0D0D0D; border:1px solid #1F1F1F;
         border-radius:16px; padding:40px 32px; }
  h1 { font-size:1.35rem; margin:0 0 12px; line-height:1.3; }
  p { color:#E0E0E0; line-height:1.6; margin:0 0 24px; font-size:1rem; }
  a { display:inline-block; background:#00C8E8; color:#050505; text-decoration:none;
      font-weight:700; padding:12px 24px; border-radius:10px; }
</style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(body)}</p>
    <a href="${escapeHtml(backHref)}">${escapeHtml(backLabel)}</a>
  </div>
</body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
      },
    },
  );
}
