/**
 * Shared chat handler — works on both Vercel Edge & Cloudflare Workers.
 *
 * Input:  Request object (Web standard)
 * Output: Response object with SSE stream
 *
 * Both platforms call this with the same signature.
 */

import { createOrchestrator } from '../lib/factory.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  ...CORS_HEADERS,
};

/**
 * Validate chat request body.
 */
function validate(body) {
  if (!body || typeof body !== 'object') return 'body must be JSON object';
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return 'messages must be non-empty array';
  }
  for (const msg of body.messages) {
    if (!msg || !msg.role || !msg.content) return 'each message needs role + content';
    if (!['user', 'assistant', 'system'].includes(msg.role)) {
      return `invalid role: ${msg.role}`;
    }
  }
  if (body.maxTokens !== undefined) {
    if (typeof body.maxTokens !== 'number' || body.maxTokens < 1 || body.maxTokens > 8000) {
      return 'maxTokens must be 1-8000';
    }
  }
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2) {
      return 'temperature must be 0-2';
    }
  }
  return null;
}

/**
 * Build SSE stream từ orchestrator events.
 */
function buildSSEStream(orchestrator, params) {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const sendEvent = (eventName, data) => {
        const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      try {
        for await (const event of orchestrator.stream(params)) {
          if (event.type === 'chunk') {
            sendEvent('chunk', { text: event.text });
          } else if (event.type === 'provider_attempt') {
            sendEvent('provider_attempt', {
              provider: event.provider,
              model: event.model,
              attempt: event.attempt,
              total_attempts: event.total_attempts,
            });
          } else if (event.type === 'meta') {
            sendEvent('meta', {
              usage: event.usage,
              model: event.model,
              provider: event.provider,
              finish_reason: event.finish_reason,
              fallback_chain: event.fallback_chain,
            });
          } else if (event.type === 'error') {
            sendEvent('error', event);
          }
        }
        sendEvent('done', {});
      } catch (err) {
        sendEvent('error', {
          message: err.message || 'Unknown error',
          recoverable: false,
        });
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Main handler — accepts a Request, returns a Response.
 *
 * @param {Request} request
 * @param {object} env - Environment vars (process.env on Vercel, env binding on CF)
 * @returns {Promise<Response>}
 */
export async function handleChatRequest(request, env) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const validationError = validate(body);
  if (validationError) {
    return new Response(
      JSON.stringify({ error: validationError }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  // Build orchestrator (per-request — env may have request-scoped overrides)
  let result;
  try {
    result = createOrchestrator(env, {
      strategy: body.strategy || 'cost_aware',
      order: body.providerOrder, // Optional override
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Configuration error: ${err.message}` }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  // Stream response
  const stream = buildSSEStream(result.orchestrator, {
    messages: body.messages,
    systemPrompt: body.systemPrompt,
    maxTokens: body.maxTokens || 1024,
    temperature: body.temperature !== undefined ? body.temperature : 1.0,
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/**
 * Health check endpoint — returns active providers without testing them
 * (testing would consume tokens; do that in a separate /test endpoint).
 */
export async function handleProvidersRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const result = createOrchestrator(env);
    return new Response(
      JSON.stringify({
        active_providers: result.orchestrator.getPlan(),
        skipped: result.skipped,
        strategy: result.orchestrator.strategy,
      }),
      { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }
}
