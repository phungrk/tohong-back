import { BaseProvider, ProviderError } from './base.js';

export class GeminiProvider extends BaseProvider {
  constructor(config) {
    super({ ...config, model: config.model || 'gemini-3-flash' });
  }

  get name() { return 'gemini'; }

  _endpoint() {
    return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
  }

  async *stream({ messages, systemPrompt, maxTokens = 1024, temperature = 1.0 }) {
    const contents = messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature,
        // Tắt "thinking" (Gemini 2.5+): nếu bật, phần suy nghĩ ngốn hết
        // maxOutputTokens → không còn token cho câu trả lời. Chat không cần.
        thinkingConfig: { thinkingBudget: 0 },
      },
      ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
    };

    let response;
    try {
      response = await this._fetchWithTimeout(this._endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const candidate = data.candidates?.[0];
      if (!candidate) continue;

      if (candidate.finishReason === 'SAFETY') {
        throw new ProviderError(this.name, 'invalid_input', 'Blocked by safety filters');
      }

      const text = candidate.content?.parts
        ?.filter((p) => p.text)
        ?.map((p) => p.text)
        ?.join('');
      if (text) yield text;

      if (candidate.finishReason) finishReason = candidate.finishReason;
      if (data.usageMetadata) {
        usage.input_tokens = data.usageMetadata.promptTokenCount || usage.input_tokens;
        usage.output_tokens = data.usageMetadata.candidatesTokenCount || usage.output_tokens;
      }
    }

    return { usage, model: this.model, provider: this.name, finish_reason: finishReason };
  }
}
