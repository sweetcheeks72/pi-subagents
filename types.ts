/**
 * Type definitions for the subagent extension
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";

// ============================================================================
// Basic Types
// ============================================================================

export interface MaxOutputConfig {
	bytes?: number;
	lines?: number;
}

export interface TruncationResult {
	text: string;
	truncated: boolean;
	originalBytes?: number;
	originalLines?: number;
	artifactPath?: string;
	/** TASK-14: Which limit(s) were hit and the configured threshold value for each.
	 *  Only the exceeded limit(s) are included:
	 *  - line-only: { lines: configuredLimit }
	 *  - byte-only: { bytes: configuredLimit }
	 *  - both:      { lines: configuredLimit, bytes: configuredLimit }
	 */
	truncatedAt?: { bytes?: number; lines?: number };
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

// ============================================================================
// Skills
// ============================================================================

export interface ResolvedSkill {
	name: string;
	path: string;
	content: string;
	source: "project" | "user";
}

// ============================================================================
// Progress Tracking
// ============================================================================

export interface AgentProgress {
	index: number;
	agent: string;
	status: "pending" | "running" | "completed" | "failed";
	task: string;
	skills?: string[];
	currentTool?: string;
	currentToolArgs?: string;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	error?: string;
	failedTool?: string;
}

export interface ProgressSummary {
	toolCount: number;
	tokens: number;
	durationMs: number;
}

// ============================================================================
// Results
// ============================================================================

export interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	outputTargetPath?: string;
	outputTargetExists?: boolean;
	sessionFile?: string;
	skills?: string[];
	skillsWarning?: string;
	progress?: AgentProgress;
	progressSummary?: ProgressSummary;
	artifactPaths?: ArtifactPaths;
	truncation?: TruncationResult;
	// TASK-01: Provider failover path (list of models tried before success/failure)
	failoverPath?: string[];
	// TASK-03: Scout graceful degradation — partial result flag
	partial: boolean;
	partialReason?: string;
	// TASK-06: Output truncation metadata (flat convenience fields)
	truncated?: boolean;
	truncatedAt?: { bytes?: number; lines?: number };
	artifactPath?: string;
	// TASK-02: Context slicing flag
	contextSliced?: boolean;
	// Tool warnings — e.g. unknown tools detected in agent output
	warnings?: string[];
}

export interface Details {
	mode: "single" | "parallel" | "chain" | "management";
	results: SingleResult[];
	asyncId?: string;
	asyncDir?: string;
	progress?: AgentProgress[];
	progressSummary?: ProgressSummary;
	artifacts?: {
		dir: string;
		files: ArtifactPaths[];
	};
	truncation?: {
		truncated: boolean;
		originalBytes?: number;
		originalLines?: number;
		artifactPath?: string;
	};
	// FIX 3: Aggregate partial flag — true if any worker result is partial
	partial?: boolean;
	// Chain metadata for observability
	chainAgents?: string[];      // Agent names in order, e.g., ["scout", "planner"]
	totalSteps?: number;         // Total steps in chain
	currentStepIndex?: number;   // 0-indexed current step (for running chains)
}

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	metadataPath: string;
}

export interface ArtifactConfig {
	enabled: boolean;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

// ============================================================================
// Async Execution
// ============================================================================

export interface AsyncStatus {
	runId: string;
	mode: "single" | "chain";
	state: "queued" | "running" | "complete" | "failed";
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	currentStep?: number;
	steps?: Array<{ agent: string; status: string; durationMs?: number; tokens?: TokenUsage; skills?: string[] }>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed";
	mode?: "single" | "chain";
	agents?: string[];
	currentStep?: number;
	stepsTotal?: number;
	startedAt?: number;
	updatedAt?: number;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

// ============================================================================
// Display
// ============================================================================

export type DisplayItem = 
	| { type: "text"; text: string } 
	| { type: "tool"; name: string; args: Record<string, unknown> };

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

// ============================================================================
// Execution Options
// ============================================================================

export interface RunSyncOptions {
	cwd?: string;
	signal?: AbortSignal;
	onUpdate?: (r: import("@mariozechner/pi-agent-core").AgentToolResult<Details>) => void;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
	runId: string;
	index?: number;
	sessionDir?: string;
	share?: boolean;
	/** Override the agent's default model (format: "provider/id" or just "id") */
	modelOverride?: string;
	/** Skills to inject (overrides agent default if provided) */
	skills?: string[];
	/** Internal: current retry attempt for instant-failure recovery */
	_retryAttempt?: number;
	/** Internal: provider failover path (models already tried and failed) */
	_failoverPath?: string[];
	/** Wall-clock timeout in ms (default: 10 * 60 * 1000). Process is killed after this duration. */
	maxDurationMs?: number;
}

export interface ExtensionConfig {
	asyncByDefault?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 200 * 1024, // 200KB — default limit (scouts and other agents)
	lines: 5000,
};

/**
 * TASK-06: Worker agents produce larger output (full implementations, test runs).
 * Use 500KB for worker/crew-worker/debug-worker agents.
 */
export const WORKER_MAX_OUTPUT: Required<MaxOutputConfig> = {
	bytes: 500 * 1024, // 500KB
	lines: 5000,
};

/** Agents that should use WORKER_MAX_OUTPUT when no explicit maxOutput is provided */
export const WORKER_AGENT_NAMES = ["worker", "crew-worker", "debug-worker"];

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
	enabled: true,
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeMetadata: true,
	cleanupDays: 7,
};

export const MAX_PARALLEL = 8;
export const MAX_CONCURRENCY = 4;
export const RESULTS_DIR = path.join(os.tmpdir(), "pi-async-subagent-results");
export const ASYNC_DIR = path.join(os.tmpdir(), "pi-async-subagent-runs");
export const WIDGET_KEY = "subagent-async";
export const POLL_INTERVAL_MS = 250;
export const MAX_WIDGET_JOBS = 4;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;

// ============================================================================
// Recursion Depth Guard
// ============================================================================

export function checkSubagentDepth(): { blocked: boolean; depth: number; maxDepth: number } {
	const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const maxDepth = Number(process.env.PI_SUBAGENT_MAX_DEPTH ?? String(DEFAULT_SUBAGENT_MAX_DEPTH));
	const blocked = Number.isFinite(depth) && Number.isFinite(maxDepth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export function getSubagentDepthEnv(): Record<string, string> {
	const parentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: process.env.PI_SUBAGENT_MAX_DEPTH ?? String(DEFAULT_SUBAGENT_MAX_DEPTH),
	};
}

// ============================================================================
// Utility Functions
// ============================================================================

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateOutput(
	output: string,
	config: Required<MaxOutputConfig>,
	artifactPath?: string,
): TruncationResult {
	const lines = output.split("\n");
	const bytes = Buffer.byteLength(output, "utf-8");

	const linesExceeded = lines.length > config.lines;
	const bytesExceeded = bytes > config.bytes;

	if (!linesExceeded && !bytesExceeded) {
		return { text: output, truncated: false };
	}

	let truncatedLines = lines;
	if (linesExceeded) {
		truncatedLines = lines.slice(0, config.lines);
	}

	let result = truncatedLines.join("\n");
	if (Buffer.byteLength(result, "utf-8") > config.bytes) {
		let low = 0;
		let high = result.length;
		while (low < high) {
			const mid = Math.floor((low + high + 1) / 2);
			if (Buffer.byteLength(result.slice(0, mid), "utf-8") <= config.bytes) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		result = result.slice(0, low);
	}

	// TASK-14: truncatedAt indicates WHICH limit was hit and the configured threshold,
	// not the original output size. Only include a field when that limit was exceeded.
	const truncatedAt: { bytes?: number; lines?: number } = {};
	if (linesExceeded) truncatedAt.lines = config.lines;
	if (bytesExceeded) truncatedAt.bytes = config.bytes;

	const kbStr = (bytes / 1024).toFixed(1);
	// TASK-14: Banner format: ⚠️ OUTPUT TRUNCATED ({N} lines / {KB}KB). Full output: {artifactPath}\n\n
	const artifactRef = artifactPath ? ` Full output: ${artifactPath}` : "";
	const marker = `⚠️ OUTPUT TRUNCATED (${lines.length} lines / ${kbStr}KB).${artifactRef}\n\n`;

	return {
		text: marker + result,
		truncated: true,
		originalBytes: bytes,
		originalLines: lines.length,
		artifactPath,
		truncatedAt,
	};
}
