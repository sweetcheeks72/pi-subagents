/**
 * Unit tests for context-slice.ts (TASK-10).
 *
 * Tests the four main acceptance criteria:
 * 1. A 60KB prose task is sliced (sliced=true, pointer written, content shortened)
 * 2. A 5KB task is unchanged (sliced=false)
 * 3. A code-heavy task is not sliced even when large
 * 4. Worker can follow the full-context pointer path to recover original content
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	sliceContext,
	isProseTask,
	SLICE_THRESHOLD_BYTES,
	FILE_ARG_THRESHOLD_BYTES,
} from "./context-slice.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-slice-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Generate a prose-heavy task string of approximately `kb` kilobytes.
 * Uses markdown headings and repeating prose lines so it looks like a real task.
 */
function generateProse(kb: number): string {
	const header =
		"# Task Overview\n\nThis task describes the goal.\n\n" +
		"## Acceptance Criteria\n\nThe implementation must pass all tests.\n\n" +
		"## Background\n\n";
	const line =
		"This is a line of prose text for testing context slicing behavior. " +
		"It contains multiple words and no code.\n";
	let result = header;
	const target = kb * 1024;
	while (Buffer.byteLength(result, "utf-8") < target) {
		result += line;
	}
	return result;
}

/**
 * Generate a code-heavy task string of approximately `kb` kilobytes.
 * Uses many small code blocks so code-fence lines exceed the 15% detection
 * threshold used by isProseTask(). Each chunk has 2 fence lines out of 4 total
 * (50% fence ratio), well above the 15% cutoff.
 */
function generateCode(kb: number): string {
	// chunk: "```typescript\n" + code line + "```\n" + blank line
	// = 4 lines, 2 of which are fences → 50% fence ratio → isProseTask returns false
	const chunk = "```typescript\nconst x = { key: 'value', nested: { a: 1 } };\n```\n\n";
	let result = "";
	const target = kb * 1024;
	while (Buffer.byteLength(result, "utf-8") < target) {
		result += chunk;
	}
	return result;
}

// ---------------------------------------------------------------------------
// isProseTask
// ---------------------------------------------------------------------------

describe("isProseTask", () => {
	it("returns true for prose-heavy content", () => {
		const prose = generateProse(5);
		assert.equal(isProseTask(prose), true, "prose content should be detected as prose");
	});

	it("returns false for code-heavy content (many code-block fences)", () => {
		const code = generateCode(5);
		assert.equal(isProseTask(code), false, "code-heavy content should not be detected as prose");
	});

	it("returns false for structured-data-heavy content", () => {
		// Many key=value or key: value lines → high structuredRatio
		const structured = Array.from({ length: 200 }, (_, i) => `key${i}: value${i}`).join("\n") + "\n";
		assert.equal(isProseTask(structured), false, "structured data should not be detected as prose");
	});

	it("returns true for small mixed content", () => {
		const mixed = "# Goal\n\nFix the login bug.\n\n## Steps\n\n1. Read the code\n2. Fix it\n";
		assert.equal(isProseTask(mixed), true);
	});
});

// ---------------------------------------------------------------------------
// sliceContext — small tasks (below threshold)
// ---------------------------------------------------------------------------

describe("sliceContext — small task (5KB)", () => {
	it("AC-2: returns sliced=false and preserves original content", () => {
		const task = generateProse(5);
		assert.ok(
			Buffer.byteLength(task, "utf-8") <= SLICE_THRESHOLD_BYTES,
			`test prereq: 5KB should be <= ${SLICE_THRESHOLD_BYTES} bytes`,
		);

		const result = sliceContext(task, tmpDir);

		assert.equal(result.sliced, false, "5KB task should not be sliced");
		assert.equal(result.content, task, "content should be unchanged");
		assert.equal(result.fullPath, undefined, "no fullPath for unsliced task");
	});

	it("does not create any files in tmpDir for small tasks", () => {
		const task = generateProse(5);
		sliceContext(task, tmpDir);
		const files = fs.readdirSync(tmpDir);
		assert.equal(files.length, 0, "no files should be written for small tasks");
	});
});

// ---------------------------------------------------------------------------
// sliceContext — 60KB prose task (main AC)
// ---------------------------------------------------------------------------

describe("sliceContext — 60KB prose task", () => {
	it("AC-1: returns sliced=true with a pointer in content", () => {
		const task = generateProse(60);
		assert.ok(
			Buffer.byteLength(task, "utf-8") > SLICE_THRESHOLD_BYTES,
			"test prereq: 60KB task must exceed 50KB threshold",
		);

		const result = sliceContext(task, tmpDir);

		assert.equal(result.sliced, true, "60KB prose task should be sliced");
		assert.ok(result.fullPath, "fullPath should be set");
		assert.ok(
			result.content.startsWith("[CONTEXT SLICED — full:"),
			"sliced content should start with context pointer",
		);
	});

	it("AC-1: sliced content contains the full-context file path", () => {
		const task = generateProse(60);
		const result = sliceContext(task, tmpDir);

		assert.equal(result.sliced, true);
		assert.ok(result.fullPath, "fullPath should be set");
		assert.ok(
			result.content.includes(result.fullPath!),
			"sliced content should embed the full-context file path",
		);
	});

	it("AC-1: sliced content is substantially smaller than the original", () => {
		const task = generateProse(60);
		const result = sliceContext(task, tmpDir);

		const originalBytes = Buffer.byteLength(task, "utf-8");
		const slicedBytes = Buffer.byteLength(result.content, "utf-8");

		assert.ok(result.sliced, "task should be sliced");
		assert.ok(
			slicedBytes < originalBytes,
			`sliced content (${slicedBytes}B) should be smaller than original (${originalBytes}B)`,
		);
	});

	it("writes full context to a file that matches the original", () => {
		const task = generateProse(60);
		const result = sliceContext(task, tmpDir);

		assert.equal(result.sliced, true);
		assert.ok(result.fullPath, "fullPath should be set");
		assert.ok(fs.existsSync(result.fullPath!), "full-context file should exist on disk");

		const written = fs.readFileSync(result.fullPath!, "utf-8");
		assert.equal(written, task, "full-context file must contain the original task verbatim");
	});

	it("AC-4: worker can follow the full-context pointer path", () => {
		// Build a task with identifiable content in both summary and prose sections
		const unique = "UNIQUE_IDENTIFIER_12345_xyzzy";
		const task =
			`# Goal\n\nImplement the ${unique} feature.\n\n` +
			"## Acceptance Criteria\n\nAll tests must pass.\n\n" +
			"## Background\n\n" +
			generateProse(60);

		const result = sliceContext(task, tmpDir);
		assert.equal(result.sliced, true);

		// Step 1: Worker parses the pointer from the sliced content
		const pointerMatch = result.content.match(/\[CONTEXT SLICED — full: (.+?)\]/);
		assert.ok(pointerMatch, "sliced content must contain a pointer the worker can parse");

		const pointedPath = pointerMatch![1];

		// Step 2: Worker reads the file at the pointer path
		assert.ok(fs.existsSync(pointedPath), "pointed file must exist and be readable");

		const fullContent = fs.readFileSync(pointedPath, "utf-8");

		// Step 3: Full content contains the original task data
		assert.ok(
			fullContent.includes(unique),
			`full-context file should contain unique identifier '${unique}'`,
		);
		assert.ok(
			fullContent.includes("Acceptance Criteria"),
			"full-context file should contain the acceptance criteria section",
		);
	});

	it("AC-4: no oversized task content is passed without a file pointer", () => {
		const task = generateProse(60);
		const result = sliceContext(task, tmpDir);

		// The sliced content must not contain the raw prose bulk
		// (it should be a compact summary, not the full 60KB)
		assert.equal(result.sliced, true);
		const slicedBytes = Buffer.byteLength(result.content, "utf-8");
		assert.ok(
			slicedBytes < SLICE_THRESHOLD_BYTES,
			`sliced content (${slicedBytes}B) must be below threshold (${SLICE_THRESHOLD_BYTES}B) — no raw oversized task should be passed inline`,
		);
	});
});

// ---------------------------------------------------------------------------
// sliceContext — code-heavy tasks
// ---------------------------------------------------------------------------

describe("sliceContext — code-heavy task (60KB)", () => {
	it("AC-3: returns sliced=false for large code-heavy task", () => {
		const task = generateCode(60);
		assert.ok(
			Buffer.byteLength(task, "utf-8") > SLICE_THRESHOLD_BYTES,
			"test prereq: 60KB code task must exceed threshold",
		);

		const result = sliceContext(task, tmpDir);

		assert.equal(result.sliced, false, "code-heavy tasks should NOT be sliced");
		assert.equal(result.fullPath, undefined, "no fullPath for code-heavy tasks");
		assert.equal(result.content, task, "code-heavy task content should be unchanged");
	});

	it("does not create context-full files for code-heavy tasks", () => {
		const task = generateCode(60);
		sliceContext(task, tmpDir);

		const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith("context-full-"));
		assert.equal(files.length, 0, "no context-full files should be created for code-heavy tasks");
	});
});

// ---------------------------------------------------------------------------
// sliceContext — deterministic file naming
// ---------------------------------------------------------------------------

describe("sliceContext — deterministic file naming", () => {
	it("produces the same file path for the same task content", () => {
		const task = generateProse(60);

		const tmp1 = fs.mkdtempSync(path.join(os.tmpdir(), "context-slice-dedup-"));
		const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "context-slice-dedup-"));
		try {
			const r1 = sliceContext(task, tmp1);
			const r2 = sliceContext(task, tmp2);

			assert.ok(r1.sliced && r2.sliced);
			// Same content → same hash → same filename (different dirs though)
			const file1 = path.basename(r1.fullPath!);
			const file2 = path.basename(r2.fullPath!);
			assert.equal(file1, file2, "same content should produce the same filename");
		} finally {
			fs.rmSync(tmp1, { recursive: true, force: true });
			fs.rmSync(tmp2, { recursive: true, force: true });
		}
	});
});
