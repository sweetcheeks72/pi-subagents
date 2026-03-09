import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempDir, removeTempDir, tryImport } from "./helpers.ts";

const mod = await tryImport<any>("./prompt-composition.ts");
const available = !!mod;
const composeInheritedSystemPrompt = mod?.composeInheritedSystemPrompt;

describe("prompt composition", { skip: !available ? "prompt-composition module not available" : undefined }, () => {
	it("composes Helios shared prompt, runtime addendum, agent prompt, then skills", () => {
		const dir = createTempDir();
		try {
			const heliosPath = path.join(dir, "helios-system.md");
			const appendPath = path.join(dir, "append-system.md");
			fs.writeFileSync(heliosPath, "You are Helios. Always introduce yourself as Helios.");
			fs.writeFileSync(appendPath, "Runtime addendum: honor runtime constraints.");

			const composed = composeInheritedSystemPrompt({
				agentSystemPrompt: "Agent-specific instructions.",
				resolvedSkills: [{
					name: "skill-a",
					path: "/tmp/skill-a/SKILL.md",
					content: "Skill instructions go here.",
					source: "project",
				}],
				sharedPromptPath: heliosPath,
				appendPromptPath: appendPath,
			});

			assert.ok(composed);
			assert.ok(composed.includes("You are Helios. Always introduce yourself as Helios."));
			assert.ok(composed.includes("Runtime addendum: honor runtime constraints."));
			assert.ok(composed.includes("Agent-specific instructions."));
			assert.ok(composed.includes("<skill name=\"skill-a\">"));
			assert.ok(composed.includes("Skill instructions go here."));

			const heliosIndex = composed.indexOf("You are Helios. Always introduce yourself as Helios.");
			const appendIndex = composed.indexOf("Runtime addendum: honor runtime constraints.");
			const agentIndex = composed.indexOf("Agent-specific instructions.");
			const skillIndex = composed.indexOf("<skill name=\"skill-a\">");
			assert.ok(heliosIndex < appendIndex, "Helios shared prompt should come before append prompt");
			assert.ok(appendIndex < agentIndex, "append prompt should come before agent prompt");
			assert.ok(agentIndex < skillIndex, "agent prompt should come before skills");
		} finally {
			removeTempDir(dir);
		}
	});

	it("preserves agent prompt when inherited files are missing", () => {
		const composed = composeInheritedSystemPrompt({
			agentSystemPrompt: "Only agent-specific instructions.",
			resolvedSkills: [],
			sharedPromptPath: "/missing/helios-system.md",
			appendPromptPath: "/missing/append-system.md",
		});

		assert.equal(composed, "Only agent-specific instructions.");
	});
});
