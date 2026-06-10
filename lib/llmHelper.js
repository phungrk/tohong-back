import { createOrchestrator } from "./factory.js";

/**
 * One-shot LLM call — collects all stream chunks into a single string.
 * Uses budget-tier model (cheaper/faster for background AI tasks).
 */
export async function callLLM(env, { systemPrompt, userPrompt, maxTokens = 512 }) {
  const { orchestrator } = createOrchestrator(env, {
    strategy: "cost_aware",
    tierForFallbacks: "budget",
    // Always use budget models for background tasks
    models: {
      claude: env.CLAUDE_MODEL || "claude-haiku-4-5",
      gpt: "gpt-5-mini",
      gemini: "gemini-3-flash",
      grok: "grok-4.1-fast",
    },
  });

  const messages = [{ role: "user", content: userPrompt }];
  let text = "";

  for await (const event of orchestrator.stream({ messages, systemPrompt, maxTokens })) {
    if (event.type === "chunk") text += event.text;
  }

  return text.trim();
}

/**
 * Parse JSON from LLM output — strips markdown code fences if present.
 */
export function parseLLMJson(text) {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  return JSON.parse(stripped);
}
