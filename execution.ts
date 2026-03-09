/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig } from "./agents.js";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "./artifacts.js";
import {
	type AgentProgress,
	type ArtifactPaths,
	type RunSyncOptions,
	type SingleResult,
	DEFAULT_MAX_OUTPUT,
	WORKER_MAX_OUTPUT,
	WORKER_AGENT_NAMES,
	truncateOutput,
	getSubagentDepthEnv,
} from "./types.js";
import {
	writePrompt,
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
} from "./utils.js";
import {
	detectProviderError,
	getNextFailoverModel,
	getFailoverDelay,
	formatFailoverPath,
	FAILOVER_SEQUENCE,
} from "./failover.js";
import { sliceContext, SLICE_THRESHOLD_BYTES } from "./context-slice.js";
import { resolveSkills } from "./skills.js";
import { composeInheritedSystemPrompt } from "./prompt-composition.js";
import { getPiSpawnCommand } from "./pi-spawn.js";
import { createJsonlWriter } from "./jsonl-writer.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Max retries for instant startup failures (lock contention, auth race).
 * Only retries when exitCode != 0 AND duration < threshold AND no messages received.
 */
const INSTANT_FAILURE_RETRY_MAX = 2;
const INSTANT_FAILURE_THRESHOLD_MS = 5000;
const INSTANT_FAILURE_RETRY_DELAY_MS = 1500;

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

/**
 * Run a subagent synchronously (blocking until complete).
 * Automatically retries on instant startup failures (lock contention).
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const { cwd, signal, onUpdate, maxOutput, artifactsDir, artifactConfig, runId, index, modelOverride } = options;
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
			error: `Unknown agent: ${agentName}`,
			partial: false,
		};
	}

	const args = ["--mode", "json", "-p"];
	const shareEnabled = options.share === true;
	const sessionEnabled = Boolean(options.sessionDir) || shareEnabled;
	if (!sessionEnabled) {
		args.push("--no-session");
	}
	if (options.sessionDir) {
		try {
			fs.mkdirSync(options.sessionDir, { recursive: true });
		} catch {}
		args.push("--session-dir", options.sessionDir);
	}
	const effectiveModel = modelOverride ?? agent.model;
	const modelArg = applyThinkingSuffix(effectiveModel, agent.thinking);
	// Use --models (not --model) because pi CLI silently ignores --model
	// without a companion --provider flag. --models resolves the provider
	// automatically via resolveModelScope. See: #8
	if (modelArg) args.push("--models", modelArg);
	const toolExtensionPaths: string[] = [];
	if (agent.tools?.length) {
		const builtinTools: string[] = [];
		for (const tool of agent.tools) {
			if (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js")) {
				toolExtensionPaths.push(tool);
			} else {
				builtinTools.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			args.push("--tools", builtinTools.join(","));
		}
	}
	if (agent.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of agent.extensions) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of toolExtensionPaths) {
			args.push("--extension", extPath);
		}
	}

	const skillNames = options.skills ?? agent.skills ?? [];
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkills(skillNames, runtimeCwd);

	const systemPrompt = composeInheritedSystemPrompt({
		agentSystemPrompt: agent.systemPrompt,
		resolvedSkills,
	}) ?? "";

	let tmpDir: string | null = null;
	if (systemPrompt) {
		const tmp = writePrompt(agent.name, systemPrompt);
		tmpDir = tmp.dir;
		args.push("--append-system-prompt", tmp.path);
	}

	// When the task is too long for a CLI argument (Windows ENAMETOOLONG),
	// write it to a temp file and use pi's @file syntax instead.
	// TASK-02: Also apply context slicing for tasks > 50KB prose content.
	const TASK_ARG_LIMIT = 8000;
	// TASK-10: Track slicing before result is declared to avoid use-before-declare bug
	let _contextSliced = false;
	if (task.length > TASK_ARG_LIMIT) {
		if (!tmpDir) {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
		}
		// TASK-02: Try context slicing for large prose tasks
		const taskBytes = Buffer.byteLength(task, "utf-8");
		let taskContent = `Task: ${task}`;
		if (taskBytes > SLICE_THRESHOLD_BYTES) {
			const sliceResult = sliceContext(task, tmpDir);
			if (sliceResult.sliced) {
				taskContent = `Task: ${sliceResult.content}`;
				_contextSliced = true;
			}
		}
		const taskFilePath = path.join(tmpDir, "task.md");
		fs.writeFileSync(taskFilePath, taskContent, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	const result: SingleResult = {
		agent: agentName,
		task,
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		partial: false,
		model: modelArg,
		skills: resolvedSkills.length > 0 ? resolvedSkills.map((s) => s.name) : undefined,
		skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
	};
	// TASK-10: Apply context slicing flag captured before result was declared
	if (_contextSliced) result.contextSliced = true;

	const progress: AgentProgress = {
		index: index ?? 0,
		agent: agentName,
		status: "running",
		task,
		skills: resolvedSkills.length > 0 ? resolvedSkills.map((s) => s.name) : undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
	};
	result.progress = progress;

	const startTime = Date.now();

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (artifactsDir && artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(artifactsDir, runId, agentName, index);
		ensureArtifactsDir(artifactsDir);
		if (artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
		if (artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
	}

	const spawnEnv = { ...process.env, ...getSubagentDepthEnv() };
	const mcpDirect = agent.mcpDirectTools;
	if (mcpDirect?.length) {
		spawnEnv.MCP_DIRECT_TOOLS = mcpDirect.join(",");
	} else {
		spawnEnv.MCP_DIRECT_TOOLS = "__none__";
	}

	let closeJsonlWriter: (() => Promise<void>) | undefined;
	// TASK-01: Track provider errors detected during streaming
	let providerErrorDetected = false;

	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: cwd ?? runtimeCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const jsonlWriter = createJsonlWriter(jsonlPath, proc.stdout);
		closeJsonlWriter = () => jsonlWriter.close();
		let buf = "";

		// Throttled update mechanism - consolidates all updates
		let lastUpdateTime = 0;
		let updatePending = false;
		let pendingTimer: ReturnType<typeof setTimeout> | null = null;
		let processClosed = false;
		const UPDATE_THROTTLE_MS = 50; // Reduced from 75ms for faster responsiveness

		const scheduleUpdate = () => {
			if (!onUpdate || processClosed) return;
			const now = Date.now();
			const elapsed = now - lastUpdateTime;

			if (elapsed >= UPDATE_THROTTLE_MS) {
				// Enough time passed, update immediately
				// Clear any pending timer to avoid double-updates
				if (pendingTimer) {
					clearTimeout(pendingTimer);
					pendingTimer = null;
				}
				lastUpdateTime = now;
				updatePending = false;
				progress.durationMs = now - startTime;
				onUpdate({
					content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
					details: { mode: "single", results: [result], progress: [progress] },
				});
			} else if (!updatePending) {
				// Schedule update for later
				updatePending = true;
				pendingTimer = setTimeout(() => {
					pendingTimer = null;
					if (updatePending && !processClosed) {
						updatePending = false;
						lastUpdateTime = Date.now();
						progress.durationMs = Date.now() - startTime;
						onUpdate({
							content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
							details: { mode: "single", results: [result], progress: [progress] },
						});
					}
				}, UPDATE_THROTTLE_MS - elapsed);
			}
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			try {
				const evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
				const now = Date.now();
				progress.durationMs = now - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
					// Tool start is important - update immediately by forcing throttle reset
					lastUpdateTime = 0;
					scheduleUpdate();
				}

				if (evt.type === "tool_execution_end") {
					if (progress.currentTool) {
						progress.recentTools.unshift({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
							endMs: now,
						});
						if (progress.recentTools.length > 5) {
							progress.recentTools.pop();
						}
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					scheduleUpdate();
				}

				if (evt.type === "message_end" && evt.message) {
					result.messages.push(evt.message);
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							progress.tokens = result.usage.input + result.usage.output;
						}
						if (!result.model && evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) {
							result.error = evt.message.errorMessage;
							// TASK-01: Flag provider-level errors for failover
							if (detectProviderError(evt.message.errorMessage)) {
								providerErrorDetected = true;
							}
						}

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							const lines = text
								.split("\n")
								.filter((l) => l.trim())
								.slice(-10);
							// Append to existing recentOutput (keep last 50 total) - mutate in place for efficiency
							progress.recentOutput.push(...lines);
							if (progress.recentOutput.length > 50) {
								progress.recentOutput.splice(0, progress.recentOutput.length - 50);
							}
						}
					}
					scheduleUpdate();
				}
				if (evt.type === "tool_result_end" && evt.message) {
					result.messages.push(evt.message);
					// Also capture tool result text in recentOutput for streaming display
					const toolText = extractTextFromContent(evt.message.content);
					if (toolText) {
						const toolLines = toolText
							.split("\n")
							.filter((l) => l.trim())
							.slice(-10);
						// Append to existing recentOutput (keep last 50 total) - mutate in place for efficiency
						progress.recentOutput.push(...toolLines);
						if (progress.recentOutput.length > 50) {
							progress.recentOutput.splice(0, progress.recentOutput.length - 50);
						}
					}
					scheduleUpdate();
				}
			} catch {}
		};

		let stderrBuf = "";

		proc.stdout.on("data", (d) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);

			// Also schedule an update on data received (handles streaming output)
			scheduleUpdate();
		});
		proc.stderr.on("data", (d) => {
			stderrBuf += d.toString();
		});
		proc.on("close", (code) => {
			processClosed = true;
			if (pendingTimer) {
				clearTimeout(pendingTimer);
				pendingTimer = null;
			}
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !result.error) {
				result.error = stderrBuf.trim();
			}
			resolve(code ?? 0);
		});
		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	if (closeJsonlWriter) {
		try {
			await closeJsonlWriter();
		} catch {}
	}

	if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
	result.exitCode = exitCode;

	if (exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progress = progress;
	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	if (artifactPathsResult && artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		const fullOutput = getFinalOutput(result.messages);

		if (artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, fullOutput);
		}
		if (artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				durationMs: progress.durationMs,
				toolCount: progress.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		// TASK-06: Use agent-specific max output limits when truncation is requested
		if (maxOutput !== undefined) {
			const baseLimit = WORKER_AGENT_NAMES.includes(agentName) ? WORKER_MAX_OUTPUT : DEFAULT_MAX_OUTPUT;
			const config = { ...baseLimit, ...maxOutput };
			const truncationResult = truncateOutput(fullOutput, config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) {
				result.truncation = truncationResult;
				// TASK-06: Flat convenience fields on result
				result.truncated = true;
				// TASK-14: truncatedAt reflects which limit was hit + threshold, from TruncationResult
				result.truncatedAt = truncationResult.truncatedAt;
				result.artifactPath = truncationResult.artifactPath;
			}
		}
	} else if (maxOutput !== undefined) {
		// TASK-06: Use agent-specific max output limits
		const baseLimit = WORKER_AGENT_NAMES.includes(agentName) ? WORKER_MAX_OUTPUT : DEFAULT_MAX_OUTPUT;
		const config = { ...baseLimit, ...maxOutput };
		const fullOutput = getFinalOutput(result.messages);
		// Save full output to a temp file so it's accessible even without artifact dir
		let truncArtifactPath: string | undefined;
		const outputBytes = Buffer.byteLength(fullOutput, "utf-8");
		const outputLines = fullOutput.split("\n").length;
		if (outputBytes > config.bytes || outputLines > config.lines) {
			try {
				const truncTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-trunc-"));
				truncArtifactPath = path.join(truncTmpDir, `${agentName}-full-output.txt`);
				fs.writeFileSync(truncArtifactPath, fullOutput);
			} catch {
				// Non-fatal: truncation artifact save failed
			}
		}
		const truncationResult = truncateOutput(fullOutput, config, truncArtifactPath);
		if (truncationResult.truncated) {
			result.truncation = truncationResult;
			// TASK-06: Flat convenience fields on result
			result.truncated = true;
			// TASK-14: truncatedAt reflects which limit was hit + threshold, from TruncationResult
			result.truncatedAt = truncationResult.truncatedAt;
			result.artifactPath = truncationResult.artifactPath;
		}
	}

	if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) {
			result.sessionFile = sessionFile;
			// HTML export disabled - module resolution issues with global pi installation
			// Users can still access the session file directly
		}
	}

	// Retry on instant startup failures (lock contention on settings.json / auth.json).
	// Detection: non-zero exit, very short duration, no messages received (process never started).
	// NOTE: This must run BEFORE provider failover to correctly handle startup crashes.
	const retryAttempt = options._retryAttempt ?? 0;
	if (
		result.exitCode !== 0 &&
		progress.durationMs < INSTANT_FAILURE_THRESHOLD_MS &&
		result.messages.length === 0 &&
		retryAttempt < INSTANT_FAILURE_RETRY_MAX &&
		!signal?.aborted
	) {
		const delay = INSTANT_FAILURE_RETRY_DELAY_MS * (retryAttempt + 1);
		await new Promise((resolve) => setTimeout(resolve, delay));
		return runSync(runtimeCwd, agents, agentName, task, {
			...options,
			_retryAttempt: retryAttempt + 1,
		});
	}

	// TASK-01: Provider failover — retry with next provider on rate_limit/overloaded errors.
	// Failover order: Anthropic x2 → OpenAI x2 → Google x2 → fail with logged path.
	// Does NOT fire during instant-failure retries (messages.length === 0 guard above
	// handles startup crashes first).
	const failoverPath = options._failoverPath ?? [];
	const currentModelLabel = modelArg ?? agent.model ?? "default";

	if ((providerErrorDetected || detectProviderError(result.error)) && !signal?.aborted) {
		const nextModel = getNextFailoverModel(currentModelLabel, failoverPath);
		const updatedFailoverPath = [...failoverPath, currentModelLabel];

		if (nextModel) {
			// Use attempt-within-provider for per-provider exponential backoff:
			// attempt 1 in any provider → 1500ms; attempt 2 → 3000ms.
			const nextEntry = FAILOVER_SEQUENCE.find((e) => e.model === nextModel);
			const delay = getFailoverDelay(nextEntry?.attempt ?? 1);
			// Log failover in progress
			if (onUpdate) {
				progress.durationMs = Date.now() - startTime;
				onUpdate({
					content: [
						{
							type: "text",
							text: `⚠️ Provider error (${result.error ?? "overloaded"}). Failing over to ${nextModel} (path: ${formatFailoverPath(updatedFailoverPath)})`,
						},
					],
					details: { mode: "single", results: [result], progress: [progress] },
				});
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
			const failoverResult = await runSync(runtimeCwd, agents, agentName, task, {
				...options,
				modelOverride: nextModel,
				_failoverPath: updatedFailoverPath,
				_retryAttempt: 0, // reset instant-failure counter for new provider
			});
			if (result.messages.length > 0) {
				if (failoverResult.partial && getFinalOutput(failoverResult.messages).startsWith("⚠️ PARTIAL:")) {
					failoverResult.messages.pop();
				}
				failoverResult.messages = [...result.messages, ...failoverResult.messages];
				if (failoverResult.partial) {
					applyGracefulDegradation(
						failoverResult,
						failoverResult.partialReason ?? failoverResult.error ?? "Subagent execution failed",
					);
				}
			}
			// The recursive call already builds the complete failoverPath via its
			// own logic (success: else-if branch; exhausted: direct assignment).
			// Do NOT concat again here — that causes path duplication.
			return failoverResult;
		}

		// All providers exhausted — log path and let final error handling synthesize output
		result.failoverPath = updatedFailoverPath;
	} else if (failoverPath.length > 0) {
		// We were in a successful failover chain — record the path
		result.failoverPath = [...failoverPath, currentModelLabel];
	}

	if (result.exitCode !== 0 && !result.partial) {
		applyGracefulDegradation(result, result.error ?? "Subagent execution failed");
	}

	// FIX: Detect silent empty output — exitCode=0 but no assistant text produced.
	// This catches scouts/workers that exit cleanly but emit nothing useful.
	if (result.exitCode === 0 && !result.partial) {
		const assistantText = collectAssistantText(result.messages);
		if (!assistantText.trim()) {
			result.partial = true;
			result.partialReason = "empty output despite successful exit";
			injectSyntheticMessage(
				result,
				"⚠️ PARTIAL (empty output): Agent completed with exit code 0 but returned no text output.\nNext step: Retry with a different prompt or check that the agent has the required tools.",
			);
		}
	}

	// Detect unknown tool warnings in agent output (e.g. search_codebase not loaded).
	// This is a detection pass only — does not retry or change execution flow.
	{
		const fullText = collectAssistantText(result.messages);
		const toolWarnings = extractToolWarnings(fullText);
		if (toolWarnings.length > 0) {
			result.warnings = toolWarnings;
		}
	}

	return result;
}

// ============================================================================
// TASK-03: Graceful Degradation
// ============================================================================

/**
 * Apply graceful degradation to a result after all retries are exhausted.
 *
 * If partial messages accumulated before failure:
 *   → Prefix output with ⚠️ PARTIAL: {reason}. Found before failure: {findings}. Recommended: {next_step}
 *   → Set exitCode=1, partial=true
 *
 * If no messages at all:
 *   → Synthesize an error response from the error message
 *   → Set exitCode=1, partial=true
 */
function applyGracefulDegradation(result: SingleResult, reason: string): void {
	result.partial = true;
	result.partialReason = reason;
	result.exitCode = 1;

	const partialOutput = collectAssistantText(result.messages);
	const text = partialOutput
		? `⚠️ PARTIAL: ${reason}. Found before failure:\n${partialOutput}`
		: `⚠️ PARTIAL: ${reason}\nNo findings were captured before failure.\nNext step: Retry with a different provider or model, or check API credentials and rate limits.`;

	injectSyntheticMessage(result, text);
}

function collectAssistantText(messages: Message[]): string {
	const sections: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "text") continue;
			const text = part.text.trim();
			if (text) sections.push(text);
		}
	}
	return sections.join("\n\n");
}

/**
 * Push a synthetic assistant message into result.messages so that
 * getFinalOutput() returns the given text.
 */
function injectSyntheticMessage(result: SingleResult, text: string): void {
	const syntheticMessage = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, total: 0 },
		},
	} as unknown as import("@mariozechner/pi-ai").Message;
	result.messages.push(syntheticMessage);
}

// ============================================================================
// Tool Warning Detection
// ============================================================================

/**
 * Scan agent output text for unknown-tool warning patterns and extract the
 * tool name(s) mentioned. This catches the case where a tool like
 * `search_codebase` is listed in the agent's tools config but the extension
 * isn't loaded in the subprocess pi runtime — the agent produces degraded
 * output with no explanation.
 *
 * Detection only — does NOT change execution flow or trigger retries.
 */
function extractToolWarnings(text: string): string[] {
	if (!text) return [];
	const warnings: string[] = [];
	const seen = new Set<string>();

	// Pattern 1: "Unknown tool: <name>" (pi error format)
	const unknownToolRegex = /unknown tool[:\s]+["']?([a-z_][a-z0-9_]*)["']?/gi;
	let m: RegExpExecArray | null;
	while ((m = unknownToolRegex.exec(text)) !== null) {
		const toolName = m[1];
		if (toolName && !seen.has(toolName)) {
			seen.add(toolName);
			warnings.push(`${toolName} not available`);
		}
	}

	// Pattern 2: "tool not found: <name>" (alternate phrasing)
	const toolNotFoundRegex = /tool not found[:\s]+["']?([a-z_][a-z0-9_]*)["']?/gi;
	while ((m = toolNotFoundRegex.exec(text)) !== null) {
		const toolName = m[1];
		if (toolName && !seen.has(toolName)) {
			seen.add(toolName);
			warnings.push(`${toolName} not available`);
		}
	}

	return warnings;
}
