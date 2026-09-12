/**
 * A cut-off AI answer must end tidily, and must never lose text the model finished.
 *
 *   npx tsx scripts/verifyEndCleanly.ts        # offline: no server, no network, no key
 *
 * The bug this pins: `llmChat` read only `message.content` and ignored
 * `finish_reason: "length"`, so an answer that the provider had CUT came back looking
 * complete. A student's opening guide therefore ended mid-sentence, and because the
 * severed line was a half-written markdown table row, raw `|` pipes were left on screen.
 *
 * The second bug, found while fixing the first: the initial repair popped every trailing
 * line starting with `|`, which deleted the whole table — including the rows the model
 * HAD finished. That is asserted against below (case 4), because "tidy up the ending" is
 * not a licence to throw away completed content.
 */
import { endCleanly } from "../src/lib/claude.ts";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}\n        ${detail}`);
  }
}

console.log("1. A complete answer is returned untouched");
const whole = "The Caro-Kann is solid.\n\n| Line | Idea |\n| --- | --- |\n| Advance | Space |";
check("not truncated means not modified", endCleanly({ text: whole, truncated: false }) === whole);
check("empty text survives", endCleanly({ text: "", truncated: true }) === "");

console.log("2. Prose cut mid-sentence backs up to the last full stop");
const prose = endCleanly({
  text: "You aim for the c5 break. It frees the bishop and challenges the centre. Black must be careful not to let White's space advantage become",
  truncated: true,
});
check("the unfinished sentence is gone", !prose.includes("become"), prose);
check("the finished sentences stay", prose.includes("It frees the bishop and challenges the centre."), prose);
check("it ends on a full stop", /\.$/.test(prose), prose);

console.log("3. The real failure: cut inside a markdown table row");
const cutRow = endCleanly({
  text: "Here are the main lines.\n\n| Variation | Plan |\n| --- | --- |\n| Advance | Play c5 |\n| Panov | Develop quickly |\n| Exchange | Min",
  truncated: true,
});
check("no half-written row survives", !cutRow.includes("| Exchange"), cutRow);
check("no raw dangling pipe at the end", !/\|\s*[A-Za-z]*$/.test(cutRow.split("\n").pop() ?? "") || cutRow.trimEnd().endsWith("|"), cutRow);

console.log("4. …and the rows the model DID finish are kept — the over-correction guard");
check("the first completed row survives", cutRow.includes("| Advance | Play c5 |"), cutRow);
check("the second completed row survives", cutRow.includes("| Panov | Develop quickly |"), cutRow);
check("the header survives with its rows", cutRow.includes("| Variation | Plan |"), cutRow);
check("the intro paragraph survives", cutRow.startsWith("Here are the main lines."), cutRow);

console.log("5. A table with no rows left is dropped, not rendered empty");
const emptyTable = endCleanly({
  text: "Here are the main lines.\n\n| Variation | Plan |\n| --- | --- |\n| Advance | Pl",
  truncated: true,
});
check("the orphaned header is gone", !emptyTable.includes("| Variation | Plan |"), emptyTable);
check("the separator row is gone", !emptyTable.includes("---"), emptyTable);
check("the prose before it is kept", emptyTable === "Here are the main lines.", JSON.stringify(emptyTable));

console.log("6. A heading that now introduces nothing is dropped");
const heading = endCleanly({
  text: "White plays for the centre.\n\n## Common mistakes\n\nThe most frequent error is",
  truncated: true,
});
check("the empty heading is gone", !heading.includes("## Common mistakes"), heading);
check("the prose above it is kept", heading === "White plays for the centre.", JSON.stringify(heading));

console.log("7. A dangling bullet marker is dropped");
const bullet = endCleanly({
  text: "Key ideas:\n\n- Play c5 early.\n- Trade the light-squared bishop.\n-",
  truncated: true,
});
check("the empty bullet is gone", !/\n-\s*$/.test(bullet), JSON.stringify(bullet));
check("the real bullets stay", bullet.includes("- Trade the light-squared bishop."), bullet);

console.log("8. Never return more than it was given");
const source = "One. Two. Three. Four and a half";
check("output is a prefix of the input", source.startsWith(endCleanly({ text: source, truncated: true })));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : `❌ ${fail} FAILED`} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
