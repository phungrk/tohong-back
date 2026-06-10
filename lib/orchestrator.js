/**
 * CostAwareFallbackOrchestrator
 *
 * Strategy: Claude (best quality) → khi fail → drop xuống cheaper providers,
 * sorted ascending by cost so each retry costs LESS (not more) than primary.
 *
 * User's stated chain: Claude → GPT → Gemini → Grok
 * Cost-aware order:   Claude → Gemini → Grok → GPT  (because GPT-5.2 expensive output)
 *
 * Default mode: 'cost_aware' — auto-sort fallbacks ascending by cost
 * Alt mode:     'fixed_order' — respect user's explicit order
 *
 * KEY CONSTRAINT (streaming):
 * - Can fallback BEFORE first token yielded
 * - CANNOT fallback after first token (would corrupt user's view)
 */

import { sortProvidersByCost } from './pricing.js';
import { ProviderError } from '../providers/base.js';

export class CostAwareFallbackOrchestrator {
  /**
   * @param {Array<BaseProvider>} providers - Primary first, rest are fallbacks
   * @param {object} [options]
   * @param {'cost_aware'|'fixed_order'} [options.strategy='cost_aware']
   * @param {boolean} [options.verbose]
   */
  constructor(providers, options = {}) {
    if (!providers?.length) throw new Error('Need at least 1 provider');
    this.primary = providers[0];
    this.fallbacks = providers.slice(1);
    this.strategy = options.strategy || 'cost_aware';
    this.verbose = options.verbose || false;
    this.maxAttemptsPerProvider = Math.max(1, options.maxAttemptsPerProvider || 1);

    // Pre-sort fallbacks if cost-aware
    if (this.strategy === 'cost_aware' && this.fallbacks.length > 1) {
      const sorted = sortProvidersByCost(
        this.fallbacks.map((p) => ({ provider: p.name, model: p.model, instance: p }))
      );
      this.fallbacks = sorted.map((s) => s.instance);
    }
  }

  _log(...args) {
    if (this.verbose) console.log('[Orchestrator]', ...args);
  }

  /**
   * Get planned execution order (for /api/providers endpoint).
   */
  getPlan() {
    return [
      { order: 1, name: this.primary.name, model: this.primary.model, role: 'primary' },
      ...this.fallbacks.map((p, i) => ({
        order: i + 2,
        name: p.name,
        model: p.model,
        role: this.strategy === 'cost_aware' ? 'fallback_by_cost' : 'fallback_fixed',
      })),
    ];
  }

  /**
   * Stream — yields event objects for SSE forwarding.
   *
   * Event types:
   * - { type: 'provider_attempt', provider, model, attempt }
   * - { type: 'chunk', text }
   * - { type: 'meta', usage, model, provider, finish_reason, fallback_chain }
   * - { type: 'error', message, recoverable, errors? }
   */
  async *stream(params) {
    const chain = [this.primary, ...this.fallbacks];
    const errors = [];
    const startTime = Date.now();
    let attemptNumber = 0;
    const totalAttempts = chain.length * this.maxAttemptsPerProvider;

    for (let i = 0; i < chain.length; i++) {
      const provider = chain[i];
      for (let providerAttempt = 1; providerAttempt <= this.maxAttemptsPerProvider; providerAttempt++) {
        const attemptStart = Date.now();
        let firstTokenYielded = false;
        attemptNumber++;

        this._log(`Attempt ${attemptNumber}/${totalAttempts}: ${provider.name} (${provider.model})`);

        yield {
          type: 'provider_attempt',
          provider: provider.name,
          model: provider.model,
          attempt: attemptNumber,
          total_attempts: totalAttempts,
        };

        try {
          const iterator = provider.stream(params);
          let finalMeta = null;

          while (true) {
            const { value, done } = await iterator.next();
            if (done) {
              finalMeta = value;
              break;
            }
            if (!firstTokenYielded) {
              firstTokenYielded = true;
              this._log(`✓ First token from ${provider.name} after ${Date.now() - attemptStart}ms`);
            }
            yield { type: 'chunk', text: value };
          }

          // Success
          yield {
            type: 'meta',
            ...finalMeta,
            fallback_chain: {
              used: provider.name,
              used_model: provider.model,
              attempts: attemptNumber,
              failed_providers: errors.map((e) => ({ provider: e.provider, category: e.category })),
              total_latency_ms: Date.now() - startTime,
              strategy: this.strategy,
            },
          };
          return;
        } catch (err) {
          const isProviderError = err instanceof ProviderError;
          const category = isProviderError ? err.category : 'unknown';
          const latency = Date.now() - attemptStart;

          errors.push({
            provider: provider.name,
            model: provider.model,
            category,
            message: err.message,
            latency_ms: latency,
            had_tokens: firstTokenYielded,
          });

          // CANNOT retry or fallback after streaming started.
          if (firstTokenYielded) {
            this._log(`✗ ${provider.name} failed MID-STREAM, cannot fallback`);
            yield {
              type: 'error',
              message: `Stream interrupted: ${err.message}`,
              recoverable: true,
              mid_stream: true,
            };
            throw err;
          }

          this._log(`✗ ${provider.name} failed in ${latency}ms (${category}): ${err.message}`);

          // Don't retry/fallback on auth or invalid input.
          if (isProviderError && !err.shouldFallback) {
            this._log(`Non-recoverable error category (${category}), aborting chain`);
            yield {
              type: 'error',
              message: `${provider.name}: ${err.message}`,
              recoverable: false,
              category,
              errors,
            };
            throw err;
          }

          if (providerAttempt < this.maxAttemptsPerProvider) {
            await new Promise((resolve) => setTimeout(resolve, 250 * providerAttempt));
          }
        }
      }
    }

    // All providers exhausted
    this._log(`All ${chain.length} providers failed`);
    yield {
      type: 'error',
      message: `All ${chain.length} providers failed`,
      recoverable: true,
      errors,
    };
    throw new Error(`All providers failed: ${errors.map((e) => `${e.provider}=${e.category}`).join(', ')}`);
  }
}
