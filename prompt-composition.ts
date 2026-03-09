import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillInjection, type ResolvedSkill } from "./skills.js";

export const DEFAULT_HELIOS_SHARED_PROMPT_PATH = path.join(os.homedir(), ".pi", "agent", "agents", "helios-system.md");
export const DEFAULT_HELIOS_APPEND_PROMPT_PATH = path.join(os.homedir(), ".pi", "agent", "APPEND_SYSTEM.md");

interface ComposeInheritedSystemPromptOptions {
	agentSystemPrompt?: string | null;
	resolvedSkills?: ResolvedSkill[];
	sharedPromptPath?: string;
	appendPromptPath?: string;
}

function readPromptPart(filePath: string | undefined): string | null {
	if (!filePath) return null;
	try {
		const content = fs.readFileSync(filePath, "utf-8").trim();
		return content || null;
	} catch {
		return null;
	}
}

export function composeInheritedSystemPrompt(options: ComposeInheritedSystemPromptOptions): string | null {
	const parts: string[] = [];
	const sharedPrompt = readPromptPart(options.sharedPromptPath ?? DEFAULT_HELIOS_SHARED_PROMPT_PATH);
	if (sharedPrompt) parts.push(sharedPrompt);

	const appendPrompt = readPromptPart(options.appendPromptPath ?? DEFAULT_HELIOS_APPEND_PROMPT_PATH);
	if (appendPrompt) parts.push(appendPrompt);

	const agentPrompt = options.agentSystemPrompt?.trim();
	if (agentPrompt) parts.push(agentPrompt);

	const skillInjection = buildSkillInjection(options.resolvedSkills ?? []);
	if (skillInjection) parts.push(skillInjection);

	return parts.length > 0 ? parts.join("\n\n") : null;
}
