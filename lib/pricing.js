/**
 * Pricing table — USD per million tokens.
 *
 * Updated May 2026. Re-verify quarterly:
 * - Anthropic: https://docs.anthropic.com/en/docs/about-claude/pricing
 * - OpenAI: https://openai.com/api/pricing
 * - Google: https://ai.google.dev/pricing
 * - xAI: https://docs.x.ai/docs/models
 *
 * Why this matters: cost-aware fallback uses these numbers to compute
 * the cheapest viable next provider when current one fails.
 */

export const PRICING = {
  claude: {
    'claude-opus-4-7':   { input: 5.00,  output: 25.00, tier: 'flagship'  },
    'claude-sonnet-4-6': { input: 3.00,  output: 15.00, tier: 'balanced'  },
    'claude-haiku-4-5':  { input: 1.00,  output: 5.00,  tier: 'budget'    },
  },
  gpt: {
    'gpt-5.2':           { input: 1.75,  output: 14.00, tier: 'flagship'  },
    'gpt-5-mini':        { input: 0.25,  output: 2.00,  tier: 'budget'    },
    'gpt-4o':            { input: 2.50,  output: 10.00, tier: 'legacy'    },
  },
  gemini: {
    'gemini-3.1-pro':    { input: 2.00,  output: 12.00, tier: 'flagship'  },
    'gemini-3-flash':    { input: 0.50,  output: 3.00,  tier: 'budget'    },
    'gemini-1.5-pro':    { input: 1.25,  output: 5.00,  tier: 'legacy'    },
  },
  grok: {
    'grok-4.3':          { input: 1.25,  output: 2.50,  tier: 'flagship'  },
    'grok-4.20':         { input: 2.00,  output: 6.00,  tier: 'balanced'  },
    'grok-4.1-fast':     { input: 0.20,  output: 0.50,  tier: 'budget'    },
  },
};

/**
 * Estimate cost cho 1 request, dùng output/input ratio thực tế (typically 4:1
 * cho chat) để có blended cost score.
 *
 * @returns {number} USD cents per request (assuming ~1000 input + 250 output tokens)
 */
export function estimateRequestCost(provider, model, inputTokens = 1000, outputTokens = 250) {
  const p = PRICING[provider]?.[model];
  if (!p) return null;
  return (p.input * inputTokens + p.output * outputTokens) / 1000; // = cents
}

/**
 * Lấy default (cheapest budget-tier) model cho mỗi provider.
 * Dùng khi user không specify model.
 */
export function getDefaultBudgetModel(provider) {
  const models = PRICING[provider];
  if (!models) return null;
  const budgetModel = Object.entries(models).find(([, p]) => p.tier === 'budget');
  return budgetModel?.[0] || Object.keys(models)[0];
}

/**
 * Sort providers theo cost ascending — useful cho cost-aware fallback
 * khi fallback từ flagship → cheap options.
 */
export function sortProvidersByCost(providerModelPairs, inputTokens = 1000, outputTokens = 250) {
  return [...providerModelPairs]
    .map((pair) => ({
      ...pair,
      cost: estimateRequestCost(pair.provider, pair.model, inputTokens, outputTokens),
    }))
    .filter((p) => p.cost !== null)
    .sort((a, b) => a.cost - b.cost);
}
