/**
 * Render the AI narratives to HTML for the PDFs.
 *
 * All three generated PDFs — game report, opponent dossier, opening guide — took the
 * model's markdown, ran it through `htmlEscape`, and wrapped each line in `<p>`. So a
 * real student's report opened with a literal
 *
 *   **Overall Assessment**
 *   - **Opening repertoire:** …
 *
 * asterisks and hyphens included, while the SAME text rendered correctly on screen
 * because the dashboard has `src/components/common/Markdown.tsx`. The screen had a
 * renderer and the PDF did not.
 *
 * This is that component's grammar, emitting an HTML string instead of React nodes:
 * headings, bold, inline code, italics, bullet and numbered lists, tables, horizontal
 * rules, paragraphs. Keeping the two in step matters — a student comparing the page with
 * the PDF is looking at the same narrative.
 *
 * SAFETY: every piece of model text is escaped BEFORE any markup is added, and the
 * markdown patterns then match against the escaped text. Model output can therefore never
 * introduce a tag. Do not reorder those two steps.
 */

export function htmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BREAK_TAG = /<\s*br\s*\/?\s*>/gi;
const ANY_TAG = /<\/?[a-zA-Z][^>]*>/g;

/** Bold, inline code and italics, inside already-escaped text. */
function inline(text: string): string {
  // The model sometimes emits a literal <br> for a line break inside a table cell.
  // Normalise those to newlines first — stripping tags first would eat them.
  const cleaned = text.replace(BREAK_TAG, "\n").replace(ANY_TAG, "");

  return htmlEscape(cleaned)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br/>");
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isDivider = (l: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");
const cells = (l: string) =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function markdownToHtml(text: string): string {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    const joined = paragraph.join(" ").trim();
    if (joined) out.push(`<p>${inline(joined)}</p>`);
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }

    // Horizontal rule — the model uses these as section separators.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flush();
      out.push("<hr/>");
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const tag = heading[1].length <= 2 ? "h2" : "h3";
      out.push(`<${tag}>${inline(heading[2].replace(/\*\*/g, ""))}</${tag}>`);
      continue;
    }

    // Fenced code / move dumps.
    if (trimmed.startsWith("```")) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      out.push(`<pre>${htmlEscape(body.join("\n").trim())}</pre>`);
      continue;
    }

    // Tables — the guide's "move / idea" table is the worst offender when raw.
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      i--;
      const thead = head.map((h) => `<th>${inline(h)}</th>`).join("");
      const tbody = rows
        .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
        .join("");
      out.push(`<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`);
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      i--;
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      i--;
      out.push(`<ol>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ol>`);
      continue;
    }

    paragraph.push(trimmed);
  }
  flush();

  return out.join("\n");
}

/** Styles for what `markdownToHtml` emits. Drop into each PDF's `<style>`. */
export const MARKDOWN_PDF_CSS = `
  .narrative h2 { font-size: 15px; margin: 22px 0 6px; padding-bottom: 4px;
                  border-bottom: 1px solid #d1d5db; }
  .narrative h3 { font-size: 12px; margin: 18px 0 4px; text-transform: uppercase;
                  letter-spacing: .04em; color: #374151; }
  .narrative p { margin: 0 0 10px; }
  .narrative ul, .narrative ol { margin: 0 0 10px; padding-left: 22px; }
  .narrative li { margin-bottom: 4px; }
  .narrative code { font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px;
                    background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  .narrative pre { background: #f3f4f6; padding: 10px; border-radius: 6px;
                   font-size: 11px; overflow-x: auto; white-space: pre-wrap; }
  .narrative hr { border: 0; border-top: 1px solid #e5e7eb; margin: 16px 0; }
  .narrative table td:first-child { font-family: "SFMono-Regular", Consolas, monospace; }
`;
