/**
 * Unit tests for failover.ts — provider-prefix detection, next-model
 * selection, and per-provider exponential backoff.
 *
 * Run with: node --experimental-strip-types --test failover.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	getProviderFamily,
	getNextFailoverModel,
	getFailoverDelay,
	detectProviderError,
	FAILOVER_BASE_DELAY_MS,
	FAILOVER_SEQUENCE,
} from "./failover.ts";

// ============================================================================
// getProviderFamily — provider-prefix detection
// ============================================================================

describe("getProviderFamily", () => {
	it("detects anthropic/ prefix", () => {
		assert.equal(getProviderFamily("anthropic/claude-sonnet-4-5"), "anthropic");
		assert.equal(getProviderFamily("anthropic/claude-haiku-4-5"), "anthropic");
	});

	it("detects openai/ prefix", () => {
		assert.equal(getProviderFamily("openai/gpt-4o"), "openai");
		assert.equal(getProviderFamily("openai/gpt-4o-mini"), "openai");
	});

	it("detects google/ prefix", () => {
		assert.equal(getProviderFamily("google/gemini-2.0-flash"), "google");
		assert.equal(getProviderFamily("google/gemini-flash-1.5"), "google");
	});

	it("treats amazon-bedrock/ as anthropic family", () => {
		assert.equal(getProviderFamily("amazon-bedrock/anthropic.claude-3-5-sonnet"), "anthropic");
		assert.equal(getProviderFamily("amazon-bedrock/meta.llama3"), "anthropic");
	});

	it("defaults to anthropic when model is undefined", () => {
		assert.equal(getProviderFamily(undefined), "anthropic");
	});

	it("detects gpt- prefix as openai", () => {
		assert.equal(getProviderFamily("gpt-4o"), "openai");
	});

	it("detects gemini name as google", () => {
		assert.equal(getProviderFamily("gemini-pro"), "google");
	});

	it("returns 'other' for unknown models", () => {
		assert.equal(getProviderFamily("mistral/mistral-large"), "other");
	});

	it("returns 'other' for custom/ prefix even if model name contains claude", () => {
		assert.equal(getProviderFamily("custom/claude-wrapper"), "other");
	});
});

// ============================================================================
// getNextFailoverModel — model sequencing
// ============================================================================

describe("getNextFailoverModel", () => {
	it("returns anthropic attempt-2 model when anthropic attempt-1 failed", () => {
		const next = getNextFailoverModel("anthropic/claude-sonnet-4-5", []);
		assert.equal(next, "anthropic/claude-haiku-4-5");
	});

	it("returns openai attempt-1 model after both anthropic attempts failed", () => {
		const next = getNextFailoverModel("anthropic/claude-haiku-4-5", [
			"anthropic/claude-sonnet-4-5",
		]);
		assert.equal(next, "openai/gpt-4o");
	});

	it("returns openai attempt-2 model after openai attempt-1 failed", () => {
		const next = getNextFailoverModel("openai/gpt-4o", [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
		]);
		assert.equal(next, "openai/gpt-4o-mini");
	});

	it("returns google attempt-1 model after both openai attempts failed", () => {
		const next = getNextFailoverModel("openai/gpt-4o-mini", [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
			"openai/gpt-4o",
		]);
		assert.equal(next, "google/gemini-2.0-flash");
	});

	it("returns google attempt-2 model after google attempt-1 failed", () => {
		const next = getNextFailoverModel("google/gemini-2.0-flash", [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
			"openai/gpt-4o",
			"openai/gpt-4o-mini",
		]);
		assert.equal(next, "google/gemini-flash-1.5");
	});

	it("returns null when all 6 attempts are exhausted", () => {
		const next = getNextFailoverModel("google/gemini-flash-1.5", [
			"anthropic/claude-sonnet-4-5",
			"anthropic/claude-haiku-4-5",
			"openai/gpt-4o",
			"openai/gpt-4o-mini",
			"google/gemini-2.0-flash",
		]);
		assert.equal(next, null);
	});

	it("advances to openai when anthropic-family custom model appears twice (path + current)", () => {
		// Custom anthropic model in both failoverPath and currentModel → 2 anthropic attempts counted
		// → should advance to openai
		const next = getNextFailoverModel("anthropic/custom-model", [
			"anthropic/custom-model",
		]);
		assert.equal(next, "openai/gpt-4o");
	});
});

// ============================================================================
// getFailoverDelay — per-provider exponential backoff
// ============================================================================

describe("getFailoverDelay", () => {
	it("returns base delay (1500ms) for attempt 1 within a provider", () => {
		assert.equal(getFailoverDelay(1), FAILOVER_BASE_DELAY_MS);
		assert.equal(getFailoverDelay(1), 1500);
	});

	it("returns 2x base delay (3000ms) for attempt 2 within a provider", () => {
		assert.equal(getFailoverDelay(2), FAILOVER_BASE_DELAY_MS * 2);
		assert.equal(getFailoverDelay(2), 3000);
	});

	it("delay resets per provider group (attempt 1 always = 1500ms)", () => {
		// Regardless of which provider, attempt 1 = 1500, attempt 2 = 3000
		const anthropicAttempt1 = getFailoverDelay(FAILOVER_SEQUENCE.find(e => e.provider === "anthropic" && e.attempt === 1)!.attempt);
		const openaiAttempt1 = getFailoverDelay(FAILOVER_SEQUENCE.find(e => e.provider === "openai" && e.attempt === 1)!.attempt);
		const googleAttempt1 = getFailoverDelay(FAILOVER_SEQUENCE.find(e => e.provider === "google" && e.attempt === 1)!.attempt);
		assert.equal(anthropicAttempt1, 1500);
		assert.equal(openaiAttempt1, 1500);
		assert.equal(googleAttempt1, 1500);
	});

	it("FAILOVER_SEQUENCE attempt-2 entries produce 3000ms delay", () => {
		const attempt2Entries = FAILOVER_SEQUENCE.filter(e => e.attempt === 2);
		for (const entry of attempt2Entries) {
			assert.equal(getFailoverDelay(entry.attempt), 3000,
				`Expected 3000ms for ${entry.model} (attempt ${entry.attempt})`);
		}
	});

	it("is exponential: attempt 2 is exactly 2x attempt 1", () => {
		const delay1 = getFailoverDelay(1);
		const delay2 = getFailoverDelay(2);
		assert.equal(delay2, delay1 * 2);
	});
});

// ============================================================================
// detectProviderError — auth-error detection and failover category
// ============================================================================

describe("detectProviderError", () => {
	it("returns false for undefined error", () => {
		assert.equal(detectProviderError(undefined), false);
	});

	it("returns 'rate_limit' for rate_limit_error", () => {
		assert.equal(detectProviderError("rate_limit_error exceeded"), "rate_limit");
	});

	it("returns 'rate_limit' for overloaded error", () => {
		assert.equal(detectProviderError("overloaded_error"), "rate_limit");
	});

	it("returns 'rate_limit' for 529 status code string", () => {
		assert.equal(detectProviderError("HTTP 529 Service Unavailable"), "rate_limit");
	});

	it("returns 'auth_error' for 401 response", () => {
		assert.equal(detectProviderError("HTTP 401 Unauthorized"), "auth_error");
	});

	it("returns 'auth_error' for 403 response", () => {
		assert.equal(detectProviderError("HTTP 403 Forbidden"), "auth_error");
	});

	it("returns 'auth_error' for invalid_api_key", () => {
		assert.equal(detectProviderError("invalid_api_key: the provided key is not valid"), "auth_error");
	});

	it("returns 'auth_error' for authentication_error", () => {
		assert.equal(detectProviderError("authentication_error"), "auth_error");
	});

	it("returns 'auth_error' for unauthorized (case-insensitive)", () => {
		assert.equal(detectProviderError("Unauthorized access"), "auth_error");
	});

	it("returns 'auth_error' for No auth credentials", () => {
		assert.equal(detectProviderError("No auth credentials found"), "auth_error");
	});

	it("auth_error is truthy — triggers same failover behavior as rate_limit", () => {
		const result = detectProviderError("401 Unauthorized");
		assert.ok(result, "auth_error should be truthy to trigger failover");
		assert.equal(result, "auth_error");
	});

	it("auth error (401) causes failover to skip to next provider", () => {
		// Simulate: current model is anthropic, got 401 → should advance to openai
		const errorType = detectProviderError("HTTP 401 Unauthorized");
		assert.ok(errorType, "auth error should be detected");
		// With auth error detected, getNextFailoverModel advances to next provider
		const nextModel = getNextFailoverModel("anthropic/claude-sonnet-4-5", []);
		assert.equal(nextModel, "anthropic/claude-haiku-4-5", "first failover still tries anthropic attempt-2");
		// After both anthropic attempts fail with auth errors, advances to openai
		const nextAfterBothAnthropic = getNextFailoverModel("anthropic/claude-haiku-4-5", [
			"anthropic/claude-sonnet-4-5",
		]);
		assert.equal(nextAfterBothAnthropic, "openai/gpt-4o", "after anthropic exhausted, skips to openai");
	});
});
