/**
 * Integration tests for single (sync) agent execution.
 *
 * Uses createMockPi() from @marcfargas/pi-test-harness to simulate the pi CLI.
 * Tests the full spawn→parse→result pipeline in runSync without a real LLM.
 *
 * These tests require pi packages to be importable (they run inside a pi
 * environment or with pi packages installed). If unavailable, tests skip
 * gracefully.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgentConfigs,
	makeAgent,
	events,
	tryImport,
} from "./helpers.ts";

// Top-level await: try importing pi-dependent modules
const execution = await tryImport<any>("./execution.ts");
const utils = await tryImport<any>("./utils.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;

describe("single sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("spawns agent and captures output", async () => {
		mockPi.onCall({ output: "Hello from mock agent" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Say hello", {});

		assert.equal(result.exitCode, 0);
		assert.equal(result.agent, "echo");
		assert.ok(result.messages.length > 0, "should have messages");

		const output = getFinalOutput(result.messages);
		assert.equal(output, "Hello from mock agent");
	});

	it("returns error for unknown agent", async () => {
		const agents = makeAgentConfigs(["echo"]);
		const result = await runSync(tempDir, agents, "nonexistent", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Unknown agent"));
	});

	it("captures non-zero exit code", async () => {
		mockPi.onCall({ exitCode: 1, stderr: "Something went wrong" });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Do something", {});

		assert.equal(result.exitCode, 1);
		assert.ok(result.error?.includes("Something went wrong"));
	});

	it("handles long tasks via temp file (ENAMETOOLONG prevention)", async () => {
		mockPi.onCall({ output: "Got it" });
		const longTask = "Analyze ".repeat(2000); // ~16KB
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", longTask, {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.equal(output, "Got it");
	});

	it("uses agent model config", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
		// result.model is set from agent config via applyThinkingSuffix, then
		// overwritten by the first message_end event only if result.model is unset.
		// Since agent has model config, it stays as the configured value.
		assert.equal(result.model, "anthropic/claude-sonnet-4");
	});

	it("model override from options takes precedence", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = [makeAgent("echo", { model: "anthropic/claude-sonnet-4" })];

		const result = await runSync(tempDir, agents, "echo", "Task", {
			modelOverride: "openai/gpt-4o",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "openai/gpt-4o");
	});

	it("tracks usage from message events", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100); // from mock
		assert.equal(result.usage.output, 50); // from mock
	});

	it("tracks progress during execution", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", { index: 3 });

		assert.ok(result.progress, "should have progress");
		assert.equal(result.progress.agent, "echo");
		assert.equal(result.progress.index, 3);
		assert.equal(result.progress.status, "completed");
		assert.ok(result.progress.durationMs > 0, "should track duration");
	});

	it("sets progress.status to failed on non-zero exit", async () => {
		mockPi.onCall({ exitCode: 1 });
		const agents = makeAgentConfigs(["fail"]);

		const result = await runSync(tempDir, agents, "fail", "Task", {});

		assert.equal(result.progress.status, "failed");
	});

	it("handles multi-turn conversation from JSONL", async () => {
		mockPi.onCall({
			jsonl: [
				events.toolStart("bash", { command: "ls" }),
				events.toolEnd("bash"),
				events.toolResult("bash", "file1.txt\nfile2.txt"),
				events.assistantMessage("Found 2 files: file1.txt and file2.txt"),
			],
		});
		const agents = makeAgentConfigs(["scout"]);

		const result = await runSync(tempDir, agents, "scout", "List files", {});

		assert.equal(result.exitCode, 0);
		const output = getFinalOutput(result.messages);
		assert.ok(output.includes("file1.txt"), "should capture assistant text");
		assert.equal(result.progress.toolCount, 1, "should count tool calls");
	});

	it("writes artifacts when configured", async () => {
		mockPi.onCall({ output: "Result text" });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts");

		const result = await runSync(tempDir, agents, "echo", "Task", {
			runId: "test-run",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: true, includeOutput: true, includeMetadata: true },
		});

		assert.equal(result.exitCode, 0);
		assert.ok(result.artifactPaths, "should have artifact paths");
		assert.ok(fs.existsSync(artifactsDir), "artifacts dir should exist");
	});

	it("handles abort signal (completes faster than delay)", async () => {
		mockPi.onCall({ delay: 10000 }); // Long delay — process should be killed before this
		const agents = makeAgentConfigs(["slow"]);
		const controller = new AbortController();

		const start = Date.now();
		setTimeout(() => controller.abort(), 200);

		const result = await runSync(tempDir, agents, "slow", "Slow task", {
			signal: controller.signal,
		});
		const elapsed = Date.now() - start;

		// The key assertion: the run should complete much faster than the 10s delay,
		// proving the abort signal terminated the process early.
		assert.ok(elapsed < 5000, `should abort early, took ${elapsed}ms`);
		// Exit code is platform-dependent (Windows: often 1 or 0, Linux: null/143)
	});

	it("handles stderr without exit code as info (not error)", async () => {
		mockPi.onCall({ output: "Success", stderr: "Warning: something", exitCode: 0 });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Task", {});

		assert.equal(result.exitCode, 0);
	});

	// -----------------------------------------------------------------------
	// TASK-10: Context slicing integration tests
	// -----------------------------------------------------------------------

	it("TASK-10: slices 60KB prose task and sets contextSliced=true", async () => {
		mockPi.onCall({ output: "Understood the task" });
		const agents = makeAgentConfigs(["worker"]);

		// Build ~60KB of prose (well above SLICE_THRESHOLD_BYTES = 50KB)
		const line =
			"This is a prose line for testing context slicing. It contains words and no code.\n";
		let bigProseTask =
			"# Goal\n\nImplement the feature.\n\n## Acceptance Criteria\n\nAll tests pass.\n\n";
		while (Buffer.byteLength(bigProseTask, "utf-8") < 61 * 1024) {
			bigProseTask += line;
		}

		const result = await runSync(tempDir, agents, "worker", bigProseTask, {});

		assert.equal(result.exitCode, 0, "should succeed");
		assert.equal(
			result.contextSliced,
			true,
			"60KB prose task should set contextSliced=true",
		);
	});

	it("TASK-10: does not slice a 5KB task (contextSliced is falsy)", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["worker"]);

		// 5KB — well below the 50KB threshold
		const smallTask = "Analyze ".repeat(300); // ~2.4KB

		const result = await runSync(tempDir, agents, "worker", smallTask, {});

		assert.equal(result.exitCode, 0);
		assert.ok(!result.contextSliced, "5KB task should NOT set contextSliced");
	});

	it("TASK-10: does not slice a code-heavy large task (contextSliced is falsy)", async () => {
		mockPi.onCall({ output: "Done" });
		const agents = makeAgentConfigs(["worker"]);

		// 60KB of many small code blocks — fence lines > 15% of total → isProseTask=false
		// Each chunk: "```typescript\n" + code line + "```\n" + blank = 4 lines, 2 fences = 50%
		const chunk = "```typescript\nconst x = { key: 'value', nested: { a: 1 } };\n```\n\n";
		let codeTask = "";
		while (Buffer.byteLength(codeTask, "utf-8") < 61 * 1024) {
			codeTask += chunk;
		}

		const result = await runSync(tempDir, agents, "worker", codeTask, {});

		assert.equal(result.exitCode, 0);
		assert.ok(
			!result.contextSliced,
			"code-heavy task should NOT be sliced even when large",
		);
	});

	// -----------------------------------------------------------------------
	// TASK-14: Truncation metadata — truncatedAt reflects which limit was hit
	// -----------------------------------------------------------------------

	it("TASK-14: line-limit truncation: truncatedAt.lines=configuredLimit, no bytes field", async () => {
		// 60 short lines; limit is 50 lines — line limit hit, byte limit not hit
		const lineOutput = Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n");
		mockPi.onCall({ output: lineOutput });
		const agents = makeAgentConfigs(["worker"]);
		const artifactsDir = path.join(tempDir, "artifacts-trunc-lines");

		const result = await runSync(tempDir, agents, "worker", "Generate output", {
			runId: "test-trunc-lines",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeMetadata: false },
			// Only lines limit will be hit — bytes limit is large enough for short lines
			maxOutput: { lines: 50, bytes: 200 * 1024 },
		});

		assert.equal(result.truncated, true, "should be truncated");
		assert.ok(result.truncatedAt, "truncatedAt should be set");
		assert.equal(result.truncatedAt?.lines, 50, "truncatedAt.lines = configured limit, not original size");
		assert.equal(result.truncatedAt?.bytes, undefined, "no bytes field for line-only truncation");
		assert.ok(result.artifactPath, "artifactPath should be set when truncated");
		assert.ok(
			result.truncation?.text.startsWith("⚠️ OUTPUT TRUNCATED ("),
			"text should start with TASK-14 banner format",
		);
	});

	it("TASK-14: byte-limit truncation: truncatedAt.bytes=configuredLimit, no lines field", async () => {
		// 3 lines of 300 chars each → ~900 bytes; limit is 200 bytes — bytes limit hit, line limit not
		const bigLine = "x".repeat(300);
		const byteOutput = `${bigLine}\n${bigLine}\n${bigLine}`;
		mockPi.onCall({ output: byteOutput });
		const agents = makeAgentConfigs(["scout"]);
		const artifactsDir = path.join(tempDir, "artifacts-trunc-bytes");

		const result = await runSync(tempDir, agents, "scout", "Generate byte output", {
			runId: "test-trunc-bytes",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeMetadata: false },
			// Only bytes limit will be hit — lines limit is large enough
			maxOutput: { lines: 5000, bytes: 200 },
		});

		assert.equal(result.truncated, true, "should be truncated");
		assert.ok(result.truncatedAt, "truncatedAt should be set");
		assert.equal(result.truncatedAt?.bytes, 200, "truncatedAt.bytes = configured limit, not original size");
		assert.equal(result.truncatedAt?.lines, undefined, "no lines field for byte-only truncation");
		assert.ok(result.artifactPath, "artifactPath should be set when truncated");
	});

	// -----------------------------------------------------------------------
	// FIX 4: Tool warnings propagate to top-level result
	// -----------------------------------------------------------------------

	it("FIX-4: detects unknown tool warnings in agent output and surfaces in result.warnings", async () => {
		mockPi.onCall({
			jsonl: [
				events.assistantMessage(
					"I'll use search_codebase to find relevant code.\nUnknown tool: search_codebase. Let me try another approach.",
				),
			],
		});
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "Find relevant code", {});

		assert.equal(result.exitCode, 0);
		assert.ok(Array.isArray(result.warnings), "warnings should be an array on result");
		assert.ok(result.warnings!.length > 0, "should detect the unknown tool warning");
		assert.ok(
			result.warnings!.some((w: string) => w.includes("search_codebase")),
			`warning should mention search_codebase, got: ${JSON.stringify(result.warnings)}`,
		);
	});

	it("TASK-14: banner format includes original size and artifactPath", async () => {
		// 10 lines, limit 5 — banner should show original 10 lines
		const output = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");
		const originalLines = 10;
		const originalKB = (Buffer.byteLength(output, "utf-8") / 1024).toFixed(1);
		mockPi.onCall({ output });
		const agents = makeAgentConfigs(["echo"]);
		const artifactsDir = path.join(tempDir, "artifacts-banner");

		const result = await runSync(tempDir, agents, "echo", "Generate output", {
			runId: "test-banner",
			artifactsDir,
			artifactConfig: { enabled: true, includeInput: false, includeOutput: true, includeMetadata: false },
			maxOutput: { lines: 5, bytes: 200 * 1024 },
		});

		assert.equal(result.truncated, true, "should be truncated");
		const bannerText = result.truncation?.text ?? "";
		// Exact format: ⚠️ OUTPUT TRUNCATED ({N} lines / {KB}KB). Full output: {path}\n\n
		assert.ok(
			bannerText.includes(`(${originalLines} lines / ${originalKB}KB).`),
			`Banner should show original size. Got: ${bannerText.slice(0, 120)}`,
		);
		assert.ok(
			bannerText.includes("Full output:"),
			"Banner should include 'Full output:' clause",
		);
		assert.ok(
			bannerText.includes(result.artifactPath ?? ""),
			"Banner should include the artifact path",
		);
	});

	// -----------------------------------------------------------------------
	// FIX 2: Tool-only responses must NOT be flagged as partial
	// -----------------------------------------------------------------------

	it("FIX-2: agent emitting only tool_use blocks (no text) must NOT be flagged partial", async () => {
		// Regression: collectAssistantText() returns "" for tool_use-only responses,
		// causing false partial detection. hasAnyActivity() checks for tool_use too.
		mockPi.onCall({
			jsonl: [
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "tool_use", id: "tool_1", name: "bash", input: { command: "ls" } }],
						model: "mock/test-model",
						usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					},
				},
			],
		});
		const agents = makeAgentConfigs(["worker"]);

		const result = await runSync(tempDir, agents, "worker", "List files", {});

		assert.equal(result.exitCode, 0, "exit code should be 0");
		assert.equal(
			result.partial,
			false,
			"tool-only response (no text) must NOT be flagged as partial — tool activity is meaningful work",
		);
	});
});

