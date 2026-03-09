/**
 * Provider failover logic for pi-subagents.
 *
 * Implements the Anthropic x2 → OpenAI x2 → Google x2 failover sequence
 * with exponential backoff per-provider. Detects provider-level errors
 * (rate_limit_error, overloaded_error) from message_end errorMessage fields.
 */

// ============================================================================
// Constants
// ============================================================================

/** Base retry delay in ms — exponential backoff applied per-provider attempt */
export const FAILOVER_BASE_DELAY_MS = 1500;

/** Maximum failover attempts across all providers (2 per provider × 3 providers) */
export const MAX_FAILOVER_ATTEMPTS = 6;

/**
 * Ordered failover sequence: Anthropic (2) → OpenAI (2) → Google (2).
 * Within each provider, we try a primary model then a lighter fallback.
 */
export interface FailoverEntry {
	provider: "anthropic" | "openai" | "google";
	model: string;
	attempt: number; // 1 or 2 within the provider
}

export const FAILOVER_SEQUENCE: FailoverEntry[] = [
	{ provider: "anthropic", model: "anthropic/claude-sonnet-4-5", attempt: 1 },
	{ provider: "anthropic", model: "anthropic/claude-haiku-4-5", attempt: 2 },
	{ provider: "openai", model: "openai/gpt-4o", attempt: 1 },
	{ provider: "openai", model: "openai/gpt-4o-mini", attempt: 2 },
	{ provider: "google", model: "google/gemini-2.0-flash", attempt: 1 },
	{ provider: "google", model: "google/gemini-flash-1.5", attempt: 2 },
];

// ============================================================================
// Error Detection
// ============================================================================

/**
 * Detect if an error message represents a provider-level rate limit or
 * overload error that should trigger failover to the next provider.
 */
export function detectProviderError(error: string | undefined): boolean {
	if (!error) return false;
	const normalized = error.toLowerCase();
	return (
		normalized.includes("rate_limit_error") ||
		normalized.includes("overloaded_error") ||
		normalized.includes("overloaded") ||
		normalized.includes("rate limit") ||
		normalized.includes("too many requests") ||
		normalized.includes("service_unavailable") ||
		normalized.includes("529") // Anthropic overloaded status code
	);
}

// ============================================================================
// Provider Family Detection
// ============================================================================

/**
 * Identify which provider family a model string belongs to.
 * Handles formats like "anthropic/claude-sonnet-4-5", "openai/gpt-4o",
 * "google/gemini-pro", "amazon-bedrock/...", etc.
 */
export function getProviderFamily(model: string | undefined): "anthropic" | "openai" | "google" | "other" {
	if (!model) return "anthropic"; // default to Anthropic
	const m = model.toLowerCase();

	// Amazon Bedrock wraps Anthropic models; treat amazon-bedrock/* as Anthropic family
	if (m.startsWith("amazon-bedrock/") || m.startsWith("anthropic/")) {
		return "anthropic";
	}
	if (m.startsWith("openai/") || m.startsWith("gpt-")) {
		return "openai";
	}
	if (m.startsWith("google/") || m.startsWith("gemini")) {
		return "google";
	}
	return "other";
}

// ============================================================================
// Failover Model Selection
// ============================================================================

/**
 * Given the current model and the path of models already tried (failed),
 * return the next model to try.
 *
 * Algorithm:
 * 1. Determine the current provider family.
 * 2. Check how many attempts have been made for this provider in failoverPath.
 * 3. If < 2, return the next model in the same provider.
 * 4. Otherwise, advance to the next provider group.
 * 5. If all providers exhausted, return null (fail with logged path).
 */
export function getNextFailoverModel(
	currentModel: string | undefined,
	failoverPath: string[],
): string | null {
	const currentProvider = getProviderFamily(currentModel);

	// Count attempts per provider in the path
	const triedByProvider = {
		anthropic: failoverPath.filter((m) => getProviderFamily(m) === "anthropic").length,
		openai: failoverPath.filter((m) => getProviderFamily(m) === "openai").length,
		google: failoverPath.filter((m) => getProviderFamily(m) === "google").length,
	};

	// Also count the current model as tried
	if (currentProvider !== "other") {
		triedByProvider[currentProvider] = (triedByProvider[currentProvider] || 0) + 1;
	}

	// Try remaining attempts in current provider first
	if (triedByProvider[currentProvider] < 2) {
		const entry = FAILOVER_SEQUENCE.find(
			(e) => e.provider === currentProvider && e.attempt === triedByProvider[currentProvider] + 1,
		);
		if (entry) return entry.model;
	}

	// Move to next provider in order
	const providerOrder: Array<"anthropic" | "openai" | "google"> = ["anthropic", "openai", "google"];
	const currentIdx = providerOrder.indexOf(currentProvider as "anthropic" | "openai" | "google");

	for (let i = Math.max(currentIdx + 1, 0); i < providerOrder.length; i++) {
		const nextProvider = providerOrder[i];
		const tried = triedByProvider[nextProvider] || 0;
		if (tried < 2) {
			const entry = FAILOVER_SEQUENCE.find(
				(e) => e.provider === nextProvider && e.attempt === tried + 1,
			);
			if (entry) return entry.model;
		}
	}

	return null; // All providers exhausted
}

// ============================================================================
// Delay Calculation
// ============================================================================

/**
 * Calculate delay before the next failover attempt.
 * Uses per-provider exponential backoff: base * 2^(attempt - 1).
 * attemptWithinProvider is the attempt number within the next provider (1 or 2):
 *   - 1st attempt in any provider → 1500ms (base * 2^0)
 *   - 2nd attempt in any provider → 3000ms (base * 2^1)
 * This resets to 1500ms each time we switch provider families.
 */
export function getFailoverDelay(attemptWithinProvider: number): number {
	return FAILOVER_BASE_DELAY_MS * Math.pow(2, attemptWithinProvider - 1);
}

// ============================================================================
// Path Formatting
// ============================================================================

/**
 * Format a failover path for logging in progress updates and final result.
 */
export function formatFailoverPath(failoverPath: string[]): string {
	if (failoverPath.length === 0) return "(none)";
	return failoverPath.join(" → ");
}
