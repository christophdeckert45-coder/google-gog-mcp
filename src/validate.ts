/**
 * Validation Script
 *
 * Verifies the server's tool schemas, imports, and structure
 * without requiring Google credentials. Run with:
 *
 *   npm run validate
 *
 * Exits 0 if everything is wired correctly, 1 otherwise.
 */

import { TOOL_MANIFEST } from "./policy/index.js";
import {
  DriveSearchSchema,
  DocsReadSchema,
  SheetsGetMetadataSchema,
  SheetsReadRangeSchema,
  SheetsExportSchema,
} from "./policy/schemas.js";

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

console.log("\n=== Poke Google Workspace MCP — Validation ===\n");

// 1. Tool manifest completeness.
console.log("1. Tool manifest");
const expectedTools = [
  "drive_search",
  "docs_read",
  "sheets_get_metadata",
  "sheets_read_range",
  "sheets_export",
];
for (const name of expectedTools) {
  const tool = TOOL_MANIFEST[name as keyof typeof TOOL_MANIFEST];
  assert(`manifest contains "${name}"`, !!tool);
  assert(`"${name}" has description`, !!tool?.description);
  assert(`"${name}" has schema`, !!tool?.schema);
}

// 2. Schema validation — valid inputs.
console.log("\n2. Schema parsing — valid inputs");

const driveValid = DriveSearchSchema.safeParse({ query: "quarterly report" });
assert("DriveSearchSchema accepts valid input", driveValid.success);

const docsValid = DocsReadSchema.safeParse({
  fileId: "abc123",
  exportFormat: "markdown",
});
assert("DocsReadSchema accepts valid input", docsValid.success);

const metaValid = SheetsGetMetadataSchema.safeParse({ fileId: "abc123" });
assert("SheetsGetMetadataSchema accepts valid input", metaValid.success);

const rangeValid = SheetsReadRangeSchema.safeParse({
  fileId: "abc123",
  range: "Sheet1!A1:D10",
});
assert("SheetsReadRangeSchema accepts valid input", rangeValid.success);

const exportValid = SheetsExportSchema.safeParse({
  fileId: "abc123",
  sheetId: 0,
});
assert("SheetsExportSchema accepts valid input", exportValid.success);

// 3. Schema validation — invalid inputs.
console.log("\n3. Schema parsing — invalid inputs rejected");

const driveInvalid = DriveSearchSchema.safeParse({});
assert(
  "DriveSearchSchema rejects missing query",
  !driveInvalid.success
);

const docsInvalid = DocsReadSchema.safeParse({
  fileId: "abc",
  exportFormat: "pdf",
});
assert(
  "DocsReadSchema rejects invalid exportFormat",
  !docsInvalid.success
);

const rangeInvalid = SheetsReadRangeSchema.safeParse({ fileId: "abc" });
assert(
  "SheetsReadRangeSchema rejects missing range",
  !rangeInvalid.success
);

// 4. Schema defaults.
console.log("\n4. Schema defaults");

const driveDefaults = DriveSearchSchema.parse({ query: "test" });
assert(
  "DriveSearchSchema default pageSize = 10",
  driveDefaults.pageSize === 10
);

const docsDefaults = DocsReadSchema.parse({ fileId: "abc" });
assert(
  'DocsReadSchema default exportFormat = "text"',
  docsDefaults.exportFormat === "text"
);

const exportDefaults = SheetsExportSchema.parse({ fileId: "abc" });
assert(
  "SheetsExportSchema default sheetId = 0",
  exportDefaults.sheetId === 0
);

// 5. Verify execution layer imports.
console.log("\n5. Execution layer imports");
try {
  const driveModule = await import("./execution/drive.js");
  assert("DriveClient importable", typeof driveModule.DriveClient === "function");

  const docsModule = await import("./execution/docs.js");
  assert("DocsClient importable", typeof docsModule.DocsClient === "function");

  const sheetsModule = await import("./execution/sheets.js");
  assert("SheetsClient importable", typeof sheetsModule.SheetsClient === "function");
} catch (err) {
  assert("Execution layer imports", false, String(err));
}

// 6. Verify orchestration layer imports.
console.log("\n6. Orchestration layer imports");
try {
  const handlers = await import("./orchestration/handlers.js");
  assert(
    "handleDriveSearch importable",
    typeof handlers.handleDriveSearch === "function"
  );
  assert(
    "handleDocsRead importable",
    typeof handlers.handleDocsRead === "function"
  );
  assert(
    "handleSheetsGetMetadata importable",
    typeof handlers.handleSheetsGetMetadata === "function"
  );
  assert(
    "handleSheetsReadRange importable",
    typeof handlers.handleSheetsReadRange === "function"
  );
  assert(
    "handleSheetsExport importable",
    typeof handlers.handleSheetsExport === "function"
  );
} catch (err) {
  assert("Orchestration layer imports", false, String(err));
}

// Summary.
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
