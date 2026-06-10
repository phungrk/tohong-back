/**
 * BaseProvider — interface chung, edge-runtime compatible.
 *
 * Edge constraints:
 * - Không có Node's `http`, `https`, `dotenv`, `fs`
 * - Chỉ dùng Web APIs: fetch, ReadableStream, TextDecoder, AbortController
 * - Env vars qua platform (Vercel, Cloudflare) — pass into constructor
 */

export class ProviderError extends Error {
  constructor(provider, category, message, originalError = null) {
    super(`[${provider}] ${category}: ${message}`);
    this.provider = provider;
    this.category = category; // 'rate_limit' | 'auth' | 'timeout' | 'server_error' | 'invalid_input' | 'unknown'
    this.originalError = originalError;
    this.shouldFallback = ['rate_limit', 'timeout', 'server_error', 'unknown'].includes(category);
  }
}

export class BaseProvider {
  constructor(config) {
    if (!config.apiKey) {
      throw new Error(`${this.constructor.name}: apiKey required`);
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs || 30_000;
    // Relay tùy chọn: nếu set, mọi request LLM đi qua relay (US) để tránh chặn vùng.
    this.relayUrl = config.relayUrl || null;
    this.relaySecret = config.relaySecret || null;
  }

  get name() {
    throw new Error('name getter must be overridden');
  }

  /**
   * Streaming-only API. Async generator yielding text chunks.
   * Returns final metadata { usage, model, provider, finish_reason }.
   */
  async *stream(params) {
    throw new Error(`${this.name}: stream() must be overridden`);
  }

  /**
   * Fetch with timeout — Web API only.
   */
  async _fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // Đi qua relay US nếu được cấu hình. Relay nhận {url, method, headers, body},
    // forward tới LLM rồi stream ngược lại — giữ nguyên streaming.
    let target = url;
    let opts = options;
    if (this.relayUrl) {
      target = this.relayUrl;
      opts = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-relay-secret': this.relaySecret || '',
        },
        body: JSON.stringify({
          url,
          method: options.method || 'GET',
          headers: options.headers || {},
          body: options.body || null,
        }),
      };
    }

    try {
      const response = await fetch(target, { ...opts, signal: controller.signal });
      return response;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ProviderError(this.name, 'timeout', `Request timeout after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  _categorizeError(response) {
    const s = response.status;
    if (s === 401 || s === 403) return 'auth';
    if (s === 429) return 'rate_limit';
    if (s === 400 || s === 422) return 'invalid_input';
    if (s >= 500) return 'server_error';
    return 'unknown';
  }

  /**
   * Helper: parse SSE stream into events. Each event is a `data: <json>\n\n` block.
   * Generator yields parsed JSON objects.
   */
  async *_parseSSEStream(response, dataPrefix = 'data: ') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE event phân tách bằng dòng trống — có server dùng \n\n, có server
        // (vd Gemini) dùng \r\n\r\n. Nhận cả hai.
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';

        for (const event of events) {
          if (!event.trim()) continue;
          const dataLine = event
            .split(/\r?\n/)
            .find((l) => l.startsWith(dataPrefix));
          if (!dataLine) continue;
          const payload = dataLine.slice(dataPrefix.length).trim();
          if (payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload);
          } catch {
            // skip malformed
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
