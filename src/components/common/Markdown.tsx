"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Minimal markdown renderer for AI-authored prose.
 *
 * The coach's guide and dossier narratives come back as markdown — headings,
 * bold, bullet lists and (often) a move/idea table. Rendered as plain text those
 * arrive on screen as literal `###`, `**` and `|---|---|` noise, which is what
 * the Opening Trainer was showing.
 *
 * Deliberately hand-rolled rather than a markdown dependency: the input is our
 * own prompt's output, the subset it uses is small, and building React nodes
 * directly avoids `dangerouslySetInnerHTML` on model-generated text entirely.
 */

/** `**bold**`, `*italic*` and `` `code` `` inside a line of text. */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let n = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyBase}-i${n++}`;
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold text-kca-white">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-kca-surface-3 px-1 py-0.5 font-mono text-[0.85em] text-kca-cyan">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isDivider = (l: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");
const cells = (l: string) =>
  l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join(" ").trim();
    if (joined) {
      blocks.push(
        <p key={`p${key++}`} className="text-kca-gray-100">
          {inline(joined, `p${key}`)}
        </p>,
      );
    }
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    // Horizontal rule — the model uses these as section separators.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      blocks.push(<hr key={`hr${key++}`} className="border-kca-border" />);
      continue;
    }

    // Headings.
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const content = inline(heading[2].replace(/\*\*/g, ""), `h${key}`);
      blocks.push(
        level <= 2 ? (
          <h3 key={`h${key++}`} className="mt-1 border-b border-kca-border pb-1.5 text-base font-semibold text-kca-white">
            {content}
          </h3>
        ) : (
          <h4 key={`h${key++}`} className="mt-1 text-sm font-semibold uppercase tracking-wide text-kca-cyan">
            {content}
          </h4>
        ),
      );
      continue;
    }

    // Fenced code / move dumps.
    if (trimmed.startsWith("```")) {
      flushParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        body.push(lines[i]);
        i++;
      }
      blocks.push(
        <pre
          key={`c${key++}`}
          className="overflow-x-auto rounded-lg border border-kca-border bg-kca-black p-3 font-mono text-xs leading-relaxed text-kca-gray-100"
        >
          {body.join("\n").trim()}
        </pre>,
      );
      continue;
    }

    // Tables — the guide's "move / idea" table is the worst offender when raw.
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      flushParagraph();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      i--;
      blocks.push(
        <div key={`t${key++}`} className="overflow-x-auto rounded-lg border border-kca-border">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="bg-kca-surface-3">
                {head.map((h, hi) => (
                  <th key={hi} className="whitespace-nowrap px-3 py-2 font-semibold text-kca-white">
                    {inline(h, `th${hi}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="border-t border-kca-border align-top">
                  {row.map((c, ci) => (
                    <td
                      key={ci}
                      className={`px-3 py-2 text-kca-gray-100 ${ci === 0 ? "whitespace-nowrap font-mono text-kca-cyan" : ""}`}
                    >
                      {inline(c, `td${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Bullet list.
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i++;
      }
      i--;
      blocks.push(
        <ul key={`u${key++}`} className="list-disc space-y-1 pl-5 marker:text-kca-cyan">
          {items.map((it, ii) => (
            <li key={ii} className="text-kca-gray-100">
              {inline(it, `li${ii}`)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list.
    if (/^\d+[.)]\s+/.test(trimmed)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      i--;
      blocks.push(
        <ol key={`o${key++}`} className="list-decimal space-y-1 pl-5 marker:font-semibold marker:text-kca-cyan">
          {items.map((it, ii) => (
            <li key={ii} className="text-kca-gray-100">
              {inline(it, `oli${ii}`)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    paragraph.push(trimmed);
  }
  flushParagraph();

  return <div className={`space-y-3 text-sm leading-relaxed ${className}`}>{blocks.map((b, i) => <Fragment key={i}>{b}</Fragment>)}</div>;
}
