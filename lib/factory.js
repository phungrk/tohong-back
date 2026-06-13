/**
 * Factory — create orchestrator from env vars.
 *
 * Edge runtime: env passed via platform (process.env in Vercel,
 * env binding in Cloudflare Workers).
 */

import { ClaudeProvider } from '../providers/claude.js';
import { GPTProvider } from '../providers/gpt.js';
import { GeminiProvider } from '../providers/gemini.js';
import { GrokProvider } from '../providers/grok.js';
import { CostAwareFallbackOrchestrator } from './orchestrator.js';
import { getDefaultBudgetModel } from './pricing.js';

const PROVIDER_REGISTRY = {
  claude: {
    Class: ClaudeProvider,
    envKey: 'CLAUDE_API_KEY',
    envModel: 'CLAUDE_MODEL',
    flagshipModel: 'claude-opus-4-7',
    budgetModel: 'claude-haiku-4-5',
  },
  gpt: {
    Class: GPTProvider,
    envKey: 'OPENAI_API_KEY',
    envModel: 'OPENAI_MODEL',
    flagshipModel: 'gpt-5.2',
    budgetModel: 'gpt-5-mini',
  },
  gemini: {
    Class: GeminiProvider,
    envKey: 'GEMINI_API_KEY',
    envModel: 'GEMINI_MODEL',
    flagshipModel: 'gemini-3.1-pro',
    budgetModel: 'gemini-3-flash',
  },
  grok: {
    Class: GrokProvider,
    envKey: 'GROK_API_KEY',
    envModel: 'GROK_MODEL',
    flagshipModel: 'grok-4.3',
    budgetModel: 'grok-4.1-fast',
  },
};

/**
 * @param {object} env - Env vars object (process.env or Cloudflare env binding)
 * @param {object} [opts]
 * @param {Array<string>} [opts.order] - Provider order (default: ['claude', 'gpt', 'gemini', 'grok'])
 * @param {'cost_aware'|'fixed_order'} [opts.strategy] - Default 'cost_aware'
 * @param {'flagship'|'budget'} [opts.tierForFallbacks] - Use cheaper models for fallbacks (default 'budget')
 * @param {Object<string,string>} [opts.models] - Override model per provider, vd { claude: 'claude-haiku-4-5-20251001' }
 * @param {number} [opts.timeoutMs]
 */
export function createOrchestrator(env, opts = {}) {
  // Thứ tự provider: opts.order > env.PROVIDER_ORDER (CSV) > mặc định.
  // Primary = phần tử đầu. VN bị Anthropic chặn vùng → đặt PROVIDER_ORDER="gemini".
  const envOrder = env.PROVIDER_ORDER
    ? env.PROVIDER_ORDER.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const order = opts.order || envOrder || ['claude', 'gpt', 'gemini', 'grok'];
  const strategy = opts.strategy || 'cost_aware';
  const tierForFallbacks = opts.tierForFallbacks || 'budget';
  const timeoutMs = opts.timeoutMs || parseInt(env.PROVIDER_TIMEOUT_MS || '30000');
  const configuredRetries = parseInt(env.PROVIDER_RETRIES || '1', 10);
  const maxAttemptsPerProvider = 1 + (
    Number.isFinite(configuredRetries) ? Math.max(0, configuredRetries) : 1
  );

  const providers = [];
  const skipped = [];

  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    const config = PROVIDER_REGISTRY[name];
    if (!config) {
      skipped.push(`${name} (unknown provider)`);
      continue;
    }

    const apiKey = env[config.envKey];
    if (!apiKey) {
      skipped.push(`${name} (no ${config.envKey})`);
      continue;
    }

    // Primary uses flagship, fallbacks use budget tier (cost optimization)
    const defaultModel = i === 0
      ? config.flagshipModel
      : (tierForFallbacks === 'budget' ? config.budgetModel : config.flagshipModel);
    // Ưu tiên: override tường minh (opts.models) > env var > default theo tier
    const model = opts.models?.[name] || env[config.envModel] || defaultModel;

    providers.push(
      new config.Class({
        apiKey,
        model,
        timeoutMs,
        relayUrl: env.LLM_RELAY_URL || null,
        relaySecret: env.RELAY_SECRET || null,
      }),
    );
  }

  if (providers.length === 0) {
    throw new Error(
      `No providers configured. Set at least one of: ${Object.values(PROVIDER_REGISTRY)
        .map((p) => p.envKey)
        .join(', ')}`
    );
  }

  return {
    orchestrator: new CostAwareFallbackOrchestrator(providers, {
      strategy,
      verbose: env.NODE_ENV !== 'production',
      maxAttemptsPerProvider,
    }),
    skipped,
    activeCount: providers.length,
  };
}
