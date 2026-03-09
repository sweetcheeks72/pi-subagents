/**
 * TASK-14: Unit tests for truncateOutput and truncation metadata.
 *
 * Tests:
 * - truncatedAt indicates WHICH limit was hit + the configured threshold value
 * - Banner format: ⚠️ OUTPUT TRUNCATED ({N} lines / {KB}KB). Full output: {path}\n\n
 * - artifactPath is stored in result
 * - originalBytes / originalLines reflect the full original output
 * - Worker agents default to 500KB
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tryImport } from "./helpers.ts";

// tryImport resolves relative to the project root (parent of test/).
// types.ts is at the project root, so use "./types.ts" (not "../types.ts").
const types = await tryImport<any>("./types.ts");
const available = !!types;

describe(
	"truncateOutput — unit tests (TASK-14)",
	{ skip: !available ? "types.ts not available" : undefined },
	() => {
		const truncateOutput = types!.truncateOutput as (
			output: string,
			config: { bytes: number; lines: number },
			artifactPath?: string,
		) => {
			text: string;
			truncated: boolean;
			originalBytes?: number;
			originalLines?: number;
			artifactPath?: string;
			truncatedAt?: { bytes?: number; lines?: number };
		};

		// ------------------------------------------------------------------
		// No truncation
		// ------------------------------------------------------------------

		it("returns untrimmed output when both limits are satisfied", () => {
			const output = "line 1\nline 2\nline 3";
			const config = { lines: 100, bytes: 10 * 1024 };
			const result = truncateOutput(output, config);

			assert.equal(result.truncated, false);
			assert.equal(result.text, output);
			assert.equal(result.truncatedAt, undefined, "truncatedAt should be absent");
		});

		// ------------------------------------------------------------------
		// Line-only truncation: truncatedAt.lines = configuredLimit, no .bytes
		// ------------------------------------------------------------------

		it("line-only: truncatedAt has lines=configuredLimit, no bytes field", () => {
			// 6 lines, limit is 5
			const output = "a\nb\nc\nd\ne\nf";
			const config = { lines: 5, bytes: 100 * 1024 };
			const result = truncateOutput(output, config, "/tmp/full.txt");

			assert.equal(result.truncated, true);
			assert.ok(result.truncatedAt, "truncatedAt must be present");
			assert.equal(result.truncatedAt!.lines, 5, "truncatedAt.lines = configured limit");
			assert.equal(
				result.truncatedAt!.bytes,
				undefined,
				"truncatedAt.bytes absent for line-only truncation",
			);
		});

		// ------------------------------------------------------------------
		// Byte-only truncation: truncatedAt.bytes = configuredLimit, no .lines
		// ------------------------------------------------------------------

		it("byte-only: truncatedAt has bytes=configuredLimit, no lines field", () => {
			// 2 lines of 300 chars each → ~600 bytes, limit is 200 bytes
			const bigLine = "x".repeat(300);
			const output = `${bigLine}\n${bigLine}`;
			const config = { lines: 1000, bytes: 200 };
			const result = truncateOutput(output, config, "/tmp/full.txt");

			assert.equal(result.truncated, true);
			assert.ok(result.truncatedAt, "truncatedAt must be present");
			assert.equal(result.truncatedAt!.bytes, 200, "truncatedAt.bytes = configured limit");
			assert.equal(
				result.truncatedAt!.lines,
				undefined,
				"truncatedAt.lines absent for byte-only truncation",
			);
		});

		// ------------------------------------------------------------------
		// Both limits exceeded: truncatedAt has both
		// ------------------------------------------------------------------

		it("both-limits: truncatedAt has lines and bytes = their configured limits", () => {
			// Lots of long lines — exceeds both line and byte limits
			const bigLine = "x".repeat(200);
			let output = "";
			for (let i = 0; i < 20; i++) output += `${bigLine}\n`;
			const config = { lines: 10, bytes: 300 };
			const result = truncateOutput(output, config, "/tmp/full.txt");

			assert.equal(result.truncated, true);
			assert.ok(result.truncatedAt, "truncatedAt must be present");
			assert.equal(result.truncatedAt!.lines, 10, "truncatedAt.lines = configured line limit");
			assert.equal(result.truncatedAt!.bytes, 300, "truncatedAt.bytes = configured byte limit");
		});

		// ------------------------------------------------------------------
		// Banner format (TASK-14)
		// ⚠️ OUTPUT TRUNCATED ({N} lines / {KB}KB). Full output: {path}\n\n
		// ------------------------------------------------------------------

		it("banner format: uses original line count and size, includes Full output path", () => {
			const output = "a\nb\nc\nd\ne\nf"; // 6 lines
			const originalBytes = Buffer.byteLength(output, "utf-8");
			const originalLines = output.split("\n").length; // 6
			const kbStr = (originalBytes / 1024).toFixed(1);
			const config = { lines: 5, bytes: 100 * 1024 };
			const artifactPath = "/tmp/full-output.txt";

			const result = truncateOutput(output, config, artifactPath);

			const expectedBanner = `⚠️ OUTPUT TRUNCATED (${originalLines} lines / ${kbStr}KB). Full output: ${artifactPath}\n\n`;
			assert.ok(
				result.text.startsWith(expectedBanner),
				`Banner mismatch.\nExpected start: ${JSON.stringify(expectedBanner)}\nGot:            ${JSON.stringify(result.text.slice(0, 120))}`,
			);
		});

		it("banner format: no 'Full output' clause when no artifactPath", () => {
			const output = "a\nb\nc\nd\ne\nf";
			const config = { lines: 5, bytes: 100 * 1024 };
			const result = truncateOutput(output, config); // no artifactPath

			assert.ok(
				!result.text.includes("Full output:"),
				"banner must not contain 'Full output:' when no artifactPath provided",
			);
		});

		it("banner format: N is original line count, not truncated count", () => {
			// 10 lines, limit 5 — banner N should be 10, not 5
			const output = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");
			const originalLines = 10;
			const config = { lines: 5, bytes: 100 * 1024 };
			const result = truncateOutput(output, config, "/tmp/out.txt");

			assert.ok(
				result.text.includes(`(${originalLines} lines /`),
				`Banner should show original ${originalLines} lines, got: ${result.text.slice(0, 80)}`,
			);
		});

		// ------------------------------------------------------------------
		// artifactPath stored in result
		// ------------------------------------------------------------------

		it("artifactPath is preserved in TruncationResult", () => {
			const output = "a\nb\nc\nd\ne\nf";
			const config = { lines: 5, bytes: 100 * 1024 };
			const result = truncateOutput(output, config, "/tmp/output.txt");

			assert.equal(result.artifactPath, "/tmp/output.txt");
		});

		it("artifactPath is undefined when not provided", () => {
			const output = "a\nb\nc\nd\ne\nf";
			const config = { lines: 5, bytes: 100 * 1024 };
			const result = truncateOutput(output, config);

			assert.equal(result.artifactPath, undefined);
		});

		// ------------------------------------------------------------------
		// originalBytes / originalLines reflect the ORIGINAL output
		// ------------------------------------------------------------------

		it("originalLines reflects full original output, not truncated", () => {
			const output = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");
			const config = { lines: 5, bytes: 100 * 1024 };
			const result = truncateOutput(output, config, "/tmp/out.txt");

			assert.equal(result.originalLines, 10, "originalLines should be 10, not 5");
		});

		it("originalBytes reflects full original byte size, not truncated", () => {
			const bigLine = "x".repeat(300);
			const output = `${bigLine}\n${bigLine}`;
			const originalBytes = Buffer.byteLength(output, "utf-8");
			const config = { lines: 1000, bytes: 200 };
			const result = truncateOutput(output, config, "/tmp/out.txt");

			assert.equal(
				result.originalBytes,
				originalBytes,
				`originalBytes should be ${originalBytes}, not truncated size`,
			);
		});

		// ------------------------------------------------------------------
		// Worker vs default byte limits (TASK-14 req #5)
		// ------------------------------------------------------------------

		it("WORKER_MAX_OUTPUT uses 500KB default", () => {
			const WORKER_MAX_OUTPUT = types!.WORKER_MAX_OUTPUT as { bytes: number; lines: number };
			assert.equal(
				WORKER_MAX_OUTPUT.bytes,
				500 * 1024,
				"Worker default should be 500KB (512000 bytes)",
			);
		});

		it("DEFAULT_MAX_OUTPUT uses 200KB default for scouts/non-workers", () => {
			const DEFAULT_MAX_OUTPUT = types!.DEFAULT_MAX_OUTPUT as { bytes: number; lines: number };
			assert.equal(
				DEFAULT_MAX_OUTPUT.bytes,
				200 * 1024,
				"Default limit should be 200KB (204800 bytes)",
			);
		});
	},
);
