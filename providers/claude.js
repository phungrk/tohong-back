import { BaseProvider, ProviderError } from './base.js';

export class ClaudeProvider extends BaseProvider {
  constructor(config) {
    super({ ...config, model: config.model || 'claude-opus-4-7' });
    this.baseUrl = 'https://api.anthropic.com/v1/messages';
  }

  get name() { return 'claude'; }

  async *stream({ messages, systemPrompt, maxTokens = 1024, temperature }) {
    const body = {
      model: this.model,
      max_tokens: maxTokens,
      stream: true,
      // `temperature` đã bị deprecate ở Opus 4.7+ → chỉ gửi khi được set
      // tường minh (model cũ vẫn nhận). Mặc định bỏ qua, để model tự dùng default.
      ...(temperature !== undefined && temperature !== null ? { temperature } : {}),
      messages: messages.map((m) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
      })),
      ...(systemPrompt ? { system: systemPrompt } : {}),
    };

    let response;
    try {
      response = await this._fetchWithTimeout(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(this.name, 'unknown', err.message, err);
    }

    if (!response.ok) {
      const errBody = await response.text();
      throw new ProviderError(
        this.name,
        this._categorizeError(response),
        `HTTP ${response.status}: ${errBody.slice(0, 200)}`
      );
    }

    let usage = { input_tokens: 0, output_tokens: 0 };
    let finishReason = null;

    for await (const data of this._parseSSEStream(response)) {
      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
        yield data.delta.text;
      } else if (data.type === 'message_start' && data.message?.usage) {
        usage.input_tokens = data.message.usage.input_tokens;
      } else if (data.type === 'message_delta') {
        if (data.usage) usage.output_tokens = data.usage.output_tokens;
        if (data.delta?.stop_reason) finishReason = data.delta.stop_reason;
      }
    }

    return { usage, model: this.model, provider: this.name, finish_reason: finishReason };
  }
}
