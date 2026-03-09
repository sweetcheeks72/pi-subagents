import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@mariozechner/pi-tui";
import { renderSubagentResult } from "./render.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function withTerminalWidth<T>(columns: number, fn: () => T): T {
	const original = process.stdout.columns;
	Object.defineProperty(process.stdout, "columns", {
		value: columns,
		configurable: true,
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(process.stdout, "columns", {
			value: original,
			configurable: true,
		});
	}
}

function makeSingleResult(output: string, overrides: Record<string, unknown> = {}) {
	return {
		content: [{ type: "text", text: output }],
		details: {
			mode: "single",
			results: [
				{
					agent: "scout",
					task: "Deep-dive scout of the repo and write down findings",
					exitCode: 0,
					messages: [
						{
							role: "assistant",
							content: [{ type: "text", text: output }],
						},
					],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					model: "gpt-test",
					partial: false,
					failoverPath: [],
					truncatedAt: undefined,
					...overrides,
				},
			],
		},
	};
}

test("renderSubagentResult collapsed single view stays compact and width-safe", () => {
	const output = "✅ DONE: Deep-dive scout of Talisman completed successfully. What I delivered: ### Context Report: /Users/chikochingaya/Desktop/Talisman Debugging/context.md Comprehensive findings with EXACT code patterns: 1. Package.json - All 50+ scripts documented.";

	const lines = withTerminalWidth(245, () => {
		const widget = renderSubagentResult(makeSingleResult(output) as never, { expanded: false }, theme as never);
		return widget.render(245);
	});

	assert.ok(lines.length <= 4, `collapsed view should stay compact, got ${lines.length} lines`);
	assert.ok(lines.every((line) => visibleWidth(line) <= 245), "every collapsed line must fit terminal width");
	assert.ok(lines.every((line) => !line.includes("✅ DONE:")), "collapsed view should not dump final output text");
});

test("renderSubagentResult expanded single view still shows final output", () => {
	const output = "✅ DONE: Deep-dive scout of Talisman completed successfully.";

	const lines = withTerminalWidth(245, () => {
		const widget = renderSubagentResult(makeSingleResult(output) as never, { expanded: true }, theme as never);
		return widget.render(245);
	});

	assert.ok(lines.some((line) => line.includes("✅ DONE:")), "expanded view should include final output");
});

test("renderSubagentResult surfaces empty inline single output as warning", () => {
	const lines = withTerminalWidth(245, () => {
		const widget = renderSubagentResult(
			makeSingleResult("", { error: "Agent returned no inline output." }) as never,
			{ expanded: false },
			theme as never,
		);
		return widget.render(245);
	});

	assert.ok(lines.some((line) => line.includes("⚠ scout")), "empty inline output should not render as ok");
	assert.ok(lines.some((line) => line.includes("Agent returned no inline output.")), "warning note should be visible");
});

test("renderSubagentResult expanded view shows failoverPath when present", () => {
	const lines = withTerminalWidth(245, () => {
		const widget = renderSubagentResult(
			makeSingleResult("Some output", { failoverPath: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o"] }) as never,
			{ expanded: true },
			theme as never,
		);
		return widget.render(245);
	});

	assert.ok(lines.some((line) => line.includes("failover:")), "expanded view should surface failover path");
});

test("renderSubagentResult expanded view shows truncatedAt when set", () => {
	const lines = withTerminalWidth(245, () => {
		const widget = renderSubagentResult(
			makeSingleResult("Some output", { truncatedAt: { lines: 5000, bytes: 204800 } }) as never,
			{ expanded: true },
			theme as never,
		);
		return widget.render(245);
	});

	assert.ok(lines.some((line) => line.includes("truncated")), "expanded view should surface truncation info");
});

test("renderSubagentResult collapsed view appends failover suffix to usage line", () => {
	const lines = withTerminalWidth(245, () => {
		const widget = renderSubagentResult(
			makeSingleResult("Done", { failoverPath: ["anthropic/claude-sonnet-4-6", "openai/gpt-4o"] }) as never,
			{ expanded: false },
			theme as never,
		);
		return widget.render(245);
	});

	assert.ok(lines.some((line) => line.includes("failover:")), "collapsed view should append failover suffix");
});
