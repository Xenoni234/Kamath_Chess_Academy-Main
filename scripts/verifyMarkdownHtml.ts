/**
 * The AI narratives must reach the PDFs as formatting, not as literal asterisks.
 *
 *   npx tsx scripts/verifyMarkdownHtml.ts        # offline: no server, no network
 *
 * The bug this pins: all three generated PDFs (game report, opponent dossier, opening
 * guide) ran the model's markdown through `htmlEscape` and wrapped each line in <p>. A
 * real student's report therefore opened with a literal `**Overall Assessment**` and
 * bullets written as `- **Opening repertoire:**`, while the SAME narrative rendered
 * correctly on screen, because the dashboard has a markdown component and the PDF did not.
 *
 * The samples below are taken verbatim from that report.
 */
import { markdownToHtml } from "../src/lib/markdown/toHtml.ts";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}\n        ${detail}`); }
}

console.log("1. The exact text from the student's report");
const real = markdownToHtml(
  "**Overall Assessment**\n\n" +
  "Xenon_i234's recent body of work (19 games, 617 own moves) shows an overall accuracy of **87.6%**.\n\n" +
  "**Key Strengths**\n\n" +
  "- **Opening repertoire:** consistently sound lines.\n" +
  "- **Endgame resilience:** **88.9%** is the highest of the three phases.\n\n" +
  "1. **Address recurring blunder patterns** - practise piece-safety drills.\n" +
  "2. **Raise middlegame accuracy** - at **85%**, this is the weakest phase.",
);
check("no literal ** survives anywhere", !real.includes("**"), real.slice(0, 160));
check("bold became <strong>", real.includes("<strong>Overall Assessment</strong>"), real.slice(0, 120));
check("a figure inside bold is kept", real.includes("<strong>87.6%</strong>"));
check("the dash bullets became a real list", real.includes("<ul>") && real.includes("<li>"), real);
check("no literal '- ' bullet leaks through", !/>\s*-\s+\*/.test(real));
check("the numbered advice became <ol>", real.includes("<ol>") && real.includes("</ol>"), real);
check("list markers are gone from the text", !real.includes("1. **") && !real.includes("2. **"));

console.log("2. Tables — the opening guide's 'common pitfalls' block");
const table = markdownToHtml(
  "Here are the pitfalls.\n\n" +
  "| Mistake | Why it's bad | Corrective idea |\n" +
  "| --- | --- | --- |\n" +
  "| Ignoring the queen check | You lose a tempo | Always meet **Qa5+** with **Bd2** |\n" +
  "| Playing c3 instead of c4 | The centre stays closed | Push **c4** on move 6 |",
);
check("a real <table> is emitted", table.includes("<table>") && table.includes("</table>"));
check("the header row became <th>", table.includes("<th>Mistake</th>"), table);
check("both data rows survive", (table.match(/<tr>/g) ?? []).length === 3, table);
check("the divider row is not rendered as data", !table.includes("<td>---</td>"), table);
check("no raw pipes remain", !table.includes("|"), table);
check("bold inside a cell still works", table.includes("<strong>Qa5+</strong>"));

console.log("3. Headings, rules and code");
const misc = markdownToHtml("## The critical test\n\n---\n\nPlay `9 Nd5!` here.\n\n#### How to meet it");
check("## became a heading", misc.includes("<h2>The critical test</h2>"), misc);
check("#### became a sub-heading", misc.includes("<h3>How to meet it</h3>"), misc);
check("--- became a rule", misc.includes("<hr/>"), misc);
check("backticks became <code>", misc.includes("<code>9 Nd5!</code>"), misc);
check("no literal # survives", !misc.includes("#"), misc);

console.log("4. Model text can never inject markup — escape happens BEFORE formatting");
const hostile = markdownToHtml("A <script>alert(1)</script> and <b>tags</b> and 5 < 6 & 7 > 2.");
check("no executable tag is emitted", !hostile.includes("<script>"), hostile);
check("no model-supplied <b> survives", !hostile.includes("<b>"), hostile);
check("a bare < is escaped", hostile.includes("&lt;") || !hostile.includes("5 < 6"), hostile);
check("an ampersand is escaped", hostile.includes("&amp;"), hostile);

console.log("5. Plain prose is still plain prose");
const plain = markdownToHtml("First paragraph.\n\nSecond paragraph.");
check("two paragraphs, two <p>", (plain.match(/<p>/g) ?? []).length === 2, plain);
check("no stray markup added", plain === "<p>First paragraph.</p>\n<p>Second paragraph.</p>", plain);
check("empty input is empty output", markdownToHtml("") === "");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
