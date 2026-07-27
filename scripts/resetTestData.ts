import { db } from "../src/lib/db";

/**
 * Deletes all ROW data while leaving the schema untouched — for clearing out
 * manually-entered test data. Discovers tables dynamically so it never drifts
 * from the Prisma schema.
 *
 * Tables listed in SKIP_TABLES are preserved. By default the imported Lichess
 * puzzle bank is kept so it does not have to be re-imported; add "opening_cache"
 * or any other table name here to preserve it too.
 *
 * Usage: npx tsx scripts/resetTestData.ts --yes
 */
const SKIP_TABLES = new Set<string>(["_prisma_migrations", "Puzzle"]);

async function main() {
  if (!process.argv.includes("--yes")) {
    console.error(
      "This deletes ALL rows from every table except: " +
        [...SKIP_TABLES].join(", ") +
        "\nRe-run with --yes to confirm:  npx tsx scripts/resetTestData.ts --yes",
    );
    process.exit(1);
  }

  const rows = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  const targets = rows.map((r) => r.tablename).filter((name) => !SKIP_TABLES.has(name));

  if (targets.length === 0) {
    console.log("No tables to truncate.");
    return;
  }

  // Quote every identifier (table names are camelCase) and CASCADE so foreign
  // keys are handled regardless of order. RESTART IDENTITY resets serials.
  const quoted = targets.map((name) => `"${name}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE;`);

  console.log(`Truncated ${targets.length} tables:\n  ${targets.join("\n  ")}`);
  console.log(`\nPreserved: ${[...SKIP_TABLES].join(", ")}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
