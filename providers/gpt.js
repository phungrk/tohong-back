import { BaseProvider, ProviderError } from './base.js';

export class GPTProvider extends BaseProvider {
  constructor(config) {
    super({ ...config, model: config.model || 'gpt-5-mini' });
    this.baseUrl = 'https://api.openai.com/v1/chat/completions';
  }

  get name() { return 'gpt'; }

  async *stream({ messages, systemPrompt, maxTokens = 1024, temperature = 1.0 }) {
    const allMessages = systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages;

    const body = {
      model: this.model,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      stream_options: { include_usage: true }, // để có token count cuối stream
      messages: allMessages,
    };

    let response;
    try {
      response = await this._fetchWithTimeout(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
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
      const delta = data.choices?.[0]?.delta;
      if (delta?.content) yield delta.content;

      if (data.choices?.[0]?.finish_reason) {
        finishReason = data.choices[0].finish_reason;
      }
      if (data.usage) {
        usage.input_tokens = data.usage.prompt_tokens || 0;
        usage.output_tokens = data.usage.completion_tokens || 0;
      }
    }

    return { usage, model: this.model, provider: this.name, finish_reason: finishReason };
  }
}
