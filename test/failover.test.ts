import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { MockPi } from "./helpers.ts";
import {
	createMockPi,
	createTempDir,
	removeTempDir,
	makeAgent,
	events,
	tryImport,
} from "./helpers.ts";

const execution = await tryImport<any>("./execution.ts");
const utils = await tryImport<any>("./utils.ts");
const available = !!(execution && utils);

const runSync = execution?.runSync;
const getFinalOutput = utils?.getFinalOutput;

function providerErrorEvent(errorMessage: string, text = "") {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: text ? [{ type: "text", text }] : [],
			model: "mock/test-model",
			errorMessage,
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		},
	};
}

describe("runSync provider failover", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	const realSetTimeout = globalThis.setTimeout;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
		(globalThis as any).setTimeout = ((fn: (...args: any[]) => void, _delay?: number, ...args: any[]) =>
			realSetTimeout(fn, 0, ...args)) as typeof setTimeout;
	});

	after(() => {
		(globalThis as any).setTimeout = realSetTimeout;
		mockPi.uninstall();
	});

	beforeEach(() => {
		tempDir = createTempDir();
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("fails over from anthropic to openai after provider 429s and records the exact path", async () => {
		mockPi.onCall({
			jsonl: [providerErrorEvent("rate_limit_error: anthropic overloaded")],
			exitCode: 1,
		});
		mockPi.onCall({
			jsonl: [providerErrorEvent("overloaded_error: anthropic still overloaded")],
			exitCode: 1,
		});
		mockPi.onCall({
			jsonl: [events.assistantMessage("Recovered on OpenAI", "openai/gpt-4o")],
			exitCode: 0,
		});

		const agents = [makeAgent("worker", { model: "anthropic/claude-sonnet-4-5" })];
		const updates: string[] = [];
		const result = await runSync(tempDir, agents, "worker", "Handle provider failover", {
			onUpdate(update: any) {
				const text = update?.content?.map((item: any) => item?.text ?? "").join("\n");
				if (text) updates.push(text);
			},
		});

		assert.equal(result.exitCode, 0);
		assert.equal(mockPi.callCount(), 3, "should try anthropic twice, then openai");
		assert.equal(result.model, "openai/gpt-4o");
		assert.deepEqual(result.failoverPath, [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
			"openai/gpt-4o",
		]);
		assert.ok(updates.some((text) => text.includes("Failing over to anthropic/claude-haiku-4-5")));
		assert.ok(updates.some((text) => text.includes("Failing over to openai/gpt-4o")));
		assert.equal(getFinalOutput(result.messages), "Recovered on OpenAI");
	});

	it("returns a structured partial failure with the full exhausted failover path", async () => {
		for (const errorMessage of [
			"rate_limit_error: anthropic primary",
			"overloaded_error: anthropic fallback",
			"rate_limit_error: openai primary",
			"overloaded_error: openai fallback",
			"rate_limit_error: google primary",
			"overloaded_error: google fallback",
		]) {
			mockPi.onCall({
				jsonl: [providerErrorEvent(errorMessage)],
				exitCode: 1,
			});
		}

		const agents = [makeAgent("worker", { model: "anthropic/claude-sonnet-4-5" })];
		const result = await runSync(tempDir, agents, "worker", "Handle provider failover", {});

		assert.equal(mockPi.callCount(), 6, "should exhaust all configured provider attempts");
		assert.equal(result.exitCode, 1);
		assert.equal(result.partial, true);
		assert.deepEqual(result.failoverPath, [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
			"openai/gpt-4o",
			"openai/gpt-4o-mini",
			"google/gemini-2.0-flash",
			"google/gemini-flash-1.5",
		]);
		assert.ok(result.error?.includes("overloaded_error"));
		assert.ok(getFinalOutput(result.messages).includes("⚠️ PARTIAL:"));
		assert.ok(getFinalOutput(result.messages).includes("google fallback"));
	});
});
