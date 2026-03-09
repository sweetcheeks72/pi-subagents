/**
 * Context slicing utility for pi-subagents.
 *
 * When task strings exceed 50KB, this module intelligently extracts the
 * structurally critical sections (goal, acceptance criteria, constraints)
 * and produces a compact ~2KB summary, saving the full context to a temp
 * file so workers can read it if needed.
 *
 * Design choices:
 * - Heuristic extraction (no LLM call) for speed and no nested subprocess
 * - Preserves goal/constraints/acceptance criteria verbatim
 * - Skips summarization for code-heavy tasks (structured data, code blocks)
 * - Full context always preserved in a temp file at the referenced path
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Constants
// ============================================================================

/** Tasks larger than this (bytes) are eligible for slicing */
export const SLICE_THRESHOLD_BYTES = 50 * 1024; // 50KB

/** Tasks between this and SLICE_THRESHOLD use @file syntax (existing behavior) */
export const FILE_ARG_THRESHOLD_BYTES = 8 * 1024; // 8KB

/** Target length for the summary portion (not counting key sections) */
export const SUMMARY_TARGET_BYTES = 2 * 1024; // ~2KB

/**
 * Section header keywords that should be preserved verbatim.
 * Case-insensitive match against markdown section headings.
 */
const KEY_SECTION_KEYWORDS = [
	"goal",
	"objective",
	"task",
	"acceptance criteria",
	"acceptance",
	"constraints",
	"requirements",
	"must",
	"deliverable",
	"definition of done",
	"scope",
	"overview",
	"summary",
	"background",
];

// ============================================================================
// Prose Detection
// ============================================================================

/**
 * Detect if a task is primarily prose vs code/structured data.
 * Code-heavy tasks are skipped for summarization to avoid stripping
 * semantically important structure.
 *
 * Heuristic: if >15% of lines are code-block fences or the majority of
 * content is inside code blocks, treat as code-heavy.
 */
export function isProseTask(task: string): boolean {
	const lines = task.split("\n");
	const codeBlockFences = lines.filter((l) => l.trim().startsWith("```")).length;
	const structuredMarkers = lines.filter(
		(l) =>
			/^\s*\{/.test(l) || // JSON
			/^\s*\[/.test(l) || // JSON array / TOML
			/^\s*\w+\s*[:=]\s*/.test(l), // key=value, key: value
	).length;

	const totalLines = Math.max(lines.length, 1);
	const codeFenceRatio = codeBlockFences / totalLines;
	const structuredRatio = structuredMarkers / totalLines;

	// More than 15% code fences or 40% structured markers → skip slicing
	return codeFenceRatio < 0.15 && structuredRatio < 0.4;
}

// ============================================================================
// Section Extraction
// ============================================================================

interface Section {
	heading: string;
	headingLevel: number;
	content: string;
	isKeySection: boolean;
}

/**
 * Parse a markdown document into sections based on headings.
 */
function parseSections(text: string): Section[] {
	const lines = text.split("\n");
	const sections: Section[] = [];
	let currentSection: Section | null = null;
	let contentLines: string[] = [];

	const flushSection = () => {
		if (currentSection) {
			currentSection.content = contentLines.join("\n").trimEnd();
			sections.push(currentSection);
			contentLines = [];
		}
	};

	for (const line of lines) {
		const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
		if (headingMatch) {
			flushSection();
			const heading = headingMatch[2].trim();
			const isKey = KEY_SECTION_KEYWORDS.some((kw) =>
				heading.toLowerCase().includes(kw.toLowerCase()),
			);
			currentSection = {
				heading,
				headingLevel: headingMatch[1].length,
				content: "",
				isKeySection: isKey,
			};
		} else if (currentSection) {
			contentLines.push(line);
		} else {
			// Content before first heading — treat as preamble
			if (!currentSection) {
				currentSection = {
					heading: "",
					headingLevel: 0,
					content: "",
					isKeySection: true, // preamble is often the goal statement
				};
			}
			contentLines.push(line);
		}
	}
	flushSection();

	// Also flush remaining content
	if (!currentSection && contentLines.length > 0) {
		sections.push({
			heading: "",
			headingLevel: 0,
			content: contentLines.join("\n").trimEnd(),
			isKeySection: true,
		});
	}

	return sections;
}

/**
 * Build a compact summary from sections.
 * - Key sections are included verbatim (truncated to reasonable size).
 * - Non-key sections are represented as "## Heading (N lines, omitted)".
 */
function buildSummary(sections: Section[], targetBytes: number): string {
	const parts: string[] = [];
	let totalBytes = 0;
	const MAX_KEY_SECTION_BYTES = 600; // per key section

	for (const section of sections) {
		if (section.isKeySection) {
			const prefix = section.heading
				? `${"#".repeat(section.headingLevel || 2)} ${section.heading}\n`
				: "";
			const content =
				section.content.length > MAX_KEY_SECTION_BYTES
					? section.content.slice(0, MAX_KEY_SECTION_BYTES) + "\n... (truncated in summary)"
					: section.content;
			const part = prefix + content + "\n";
			parts.push(part);
			totalBytes += Buffer.byteLength(part, "utf-8");

			if (totalBytes >= targetBytes) break;
		} else {
			// Non-key section: just show the heading
			const lineCount = section.content.split("\n").filter((l) => l.trim()).length;
			const prefix = section.heading
				? `${"#".repeat(section.headingLevel || 2)} ${section.heading}`
				: "";
			if (prefix) {
				const part = `${prefix} *(${lineCount} lines, see full context)*\n`;
				parts.push(part);
				totalBytes += Buffer.byteLength(part, "utf-8");
			}
		}
	}

	return parts.join("\n");
}

// ============================================================================
// Main Slice Function
// ============================================================================

export interface SliceResult {
	/** Whether slicing was applied */
	sliced: boolean;
	/** The (possibly sliced) content to pass to the agent */
	content: string;
	/** Path to the full context file (present when sliced=true) */
	fullPath?: string;
}

/**
 * Slice a task string if it exceeds the threshold.
 *
 * - Below FILE_ARG_THRESHOLD_BYTES: no change (inline)
 * - Between thresholds: no slice (caller uses @file syntax)
 * - Above SLICE_THRESHOLD_BYTES AND prose: slice + save full to file
 * - Above SLICE_THRESHOLD_BYTES AND code-heavy: no slice (pass verbatim via @file)
 *
 * @param task     The raw task string.
 * @param tmpDir   Directory to write the full context file to.
 */
export function sliceContext(task: string, tmpDir: string): SliceResult {
	const bytes = Buffer.byteLength(task, "utf-8");

	// Below threshold — no slicing
	if (bytes <= SLICE_THRESHOLD_BYTES) {
		return { sliced: false, content: task };
	}

	// Code-heavy tasks — skip summarization, return unchanged (will be written to @file)
	if (!isProseTask(task)) {
		return { sliced: false, content: task };
	}

	// Save full context to a deterministic temp file
	const hash = crypto.createHash("md5").update(task).digest("hex").slice(0, 8);
	const fullPath = path.join(tmpDir, `context-full-${hash}.md`);
	fs.writeFileSync(fullPath, task, { mode: 0o600 });

	// Build a compact summary of the key sections
	const sections = parseSections(task);
	const summary = buildSummary(sections, SUMMARY_TARGET_BYTES);

	// Prepend the context reference
	const slicedContent = `[CONTEXT SLICED — full: ${fullPath}]\n\n${summary}`;

	return {
		sliced: true,
		content: slicedContent,
		fullPath,
	};
}
