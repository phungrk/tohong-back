# Wedding Planner Edge Function — Multi-LLM với Cost-Aware Fallback

Streaming chat API trên edge (Vercel hoặc Cloudflare Workers) với fallback chain qua 4 providers: Claude → GPT → Gemini → Grok.

## ✨ Features

- **🚀 Edge runtime**: <50ms cold start, deploy gần user (Singapore/HK cho VN)
- **💰 Cost-aware fallback**: Khi primary fail, tự động retry với cheapest available
- **🔄 Streaming-only**: SSE token-by-token, UX không pause
- **🛡️ Smart error handling**: Auth/invalid errors KHÔNG retry (waste tokens)
- **📊 Observability**: Mỗi response có `fallback_chain` showing which provider used, latency, failed attempts

## 📁 Project structure

```
edge/
├── api/                    # Vercel entry points
│   ├── chat.js            # POST /api/chat
│   └── providers.js       # GET /api/providers
├── worker.js              # Cloudflare entry (single file)
├── wrangler.toml          # Cloudflare config
├── vercel.json            # Vercel config
├── lib/
│   ├── handler.js         # Shared request handler
│   ├── orchestrator.js    # Cost-aware fallback core
│   ├── factory.js         # Build orchestrator from env
│   └── pricing.js         # Token pricing data
├── providers/
│   ├── base.js            # Abstract provider interface
│   ├── claude.js          # Anthropic Messages API
│   ├── gpt.js             # OpenAI Chat Completions
│   ├── gemini.js          # Google Gemini API
│   └── grok.js            # xAI Grok API
├── client/
│   └── useEdgeChat.js     # React hook
└── test/
    └── test_fallback.js   # Fallback logic tests
```

## 💰 Pricing & cost-aware logic

**Current pricing (May 2026), per million tokens:**

| Provider | Flagship | Budget tier |
|---|---|---|
| Claude | Opus 4.7: $5/$25 | Haiku 4.5: $1/$5 |
| GPT | 5.2: $1.75/$14 | 5-mini: $0.25/$2 |
| Gemini | 3.1 Pro: $2/$12 | 3 Flash: $0.50/$3 |
| Grok | 4.3: $1.25/$2.50 | 4.1 Fast: $0.20/$0.50 |

**Cost-aware fallback order** (cho 1K input + 250 output tokens):

```
1. Claude Opus 4.7    ← primary (best quality)
2. Grok 4.1 Fast      ← cheapest fallback ($0.125 / req)
3. GPT-5 mini         ← ($0.75 / req)
4. Gemini 3 Flash     ← ($1.25 / req)
```

Đây là default. Nếu muốn `fixed_order` (theo thứ tự user define), set `strategy: 'fixed_order'` trong request body.

## 🚀 Setup

### Option A: Vercel

```bash
cd edge/
npm install -D vercel
vercel login
vercel link

# Set secrets
vercel env add CLAUDE_API_KEY
vercel env add OPENAI_API_KEY
vercel env add GEMINI_API_KEY
vercel env add GROK_API_KEY

# Deploy
vercel --prod
```

URLs:
- `POST https://your-app.vercel.app/api/chat`
- `GET https://your-app.vercel.app/api/providers`

### Option B: Cloudflare Workers

```bash
cd edge/
npm install -D wrangler
wrangler login

# Set secrets
wrangler secret put CLAUDE_API_KEY
wrangler secret put OPENAI_API_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put GROK_API_KEY

# Deploy
wrangler deploy
```

URLs:
- `POST https://wedding-planner-edge.YOUR-NAME.workers.dev/api/chat`

### Partial deployment OK

Không cần tất cả 4 API keys. Set 1-2 keys cũng OK; orchestrator skip providers không có key. Minimum: 1 provider.

## 📡 API

### POST /api/chat

Request:
```json
{
  "messages": [
    { "role": "user", "content": "Tôi muốn cưới ở Sài Gòn, 200 khách, 500tr" }
  ],
  "systemPrompt": "Bạn là Lead Planner...",
  "maxTokens": 1024,
  "temperature": 0.7,
  "strategy": "cost_aware",
  "providerOrder": ["claude", "gpt", "gemini", "grok"]
}
```

Response: Server-Sent Events stream.

```
event: provider_attempt
data: {"provider":"claude","model":"claude-opus-4-7","attempt":1,"total_attempts":4}

event: chunk
data: {"text":"Em đề xuất "}

event: chunk
data: {"text":"phân bổ ngân sách như sau..."}

event: meta
data: {"usage":{"input_tokens":85,"output_tokens":312},"model":"claude-opus-4-7","provider":"claude","fallback_chain":{...}}

event: done
data: {}
```

Nếu Claude fail trước token đầu:
```
event: provider_attempt
data: {"provider":"claude",...,"attempt":1}

event: provider_attempt
data: {"provider":"grok",...,"attempt":2}      ← auto fallback

event: chunk
data: {"text":"..."}
```

### GET /api/providers

Returns active providers + execution plan:
```json
{
  "active_providers": [
    { "order": 1, "name": "claude", "model": "claude-opus-4-7", "role": "primary" },
    { "order": 2, "name": "grok", "model": "grok-4.1-fast", "role": "fallback_by_cost" },
    { "order": 3, "name": "gpt", "model": "gpt-5-mini", "role": "fallback_by_cost" },
    { "order": 4, "name": "gemini", "model": "gemini-3-flash", "role": "fallback_by_cost" }
  ],
  "skipped": [],
  "strategy": "cost_aware"
}
```

## ⚛️ React integration

```jsx
import { useEdgeChat } from './client/useEdgeChat.js';

function ChatComponent() {
  const {
    messages,
    sendMessage,
    isStreaming,
    currentProvider,
    fallbackInfo,
    error,
  } = useEdgeChat({
    endpoint: 'https://your-app.vercel.app/api/chat',
    systemPrompt: 'Bạn là Lead Planner cho wedding Việt Nam...',
  });

  return (
    <div>
      {messages.map((m, i) => (
        <div key={i}>
          <strong>{m.role}:</strong> {m.content}
          {m.streaming && <span>▍</span>}
        </div>
      ))}

      {isStreaming && currentProvider && (
        <small>
          Streaming from {currentProvider.name} (attempt {currentProvider.attempt}/{currentProvider.total})
        </small>
      )}

      {fallbackInfo?.attempts > 1 && (
        <small>
          ⚠️ Primary failed, used {fallbackInfo.used} ({fallbackInfo.usedModel})
        </small>
      )}

      <button onClick={() => sendMessage('Hỏi gì đó')}>Send</button>
    </div>
  );
}
```

## 🛡️ Fallback decision matrix

| Error category | Should fallback? | Why |
|---|---|---|
| `rate_limit` (429) | ✓ Yes | Other providers may have capacity |
| `timeout` | ✓ Yes | Network issue, try different endpoint |
| `server_error` (5xx) | ✓ Yes | Provider outage |
| `unknown` | ✓ Yes | Be defensive |
| `auth` (401/403) | ✗ NO | Admin issue, retrying wastes time |
| `invalid_input` (400) | ✗ NO | Bad request, all providers will fail |

## ⚠️ Streaming constraints

**Quy tắc**: Nếu primary đã yield token đầu, KHÔNG fallback được vì user đã thấy text dở.

```
Time:  0ms                    1500ms              2000ms
       |                      |                   |
       claude.stream()  →  yields "Em đề..."  →  ERROR
       
       Cannot fallback to grok now — user sees corrupt response.
```

Trong case này, error được surface với `mid_stream: true`, client có thể prompt user retry.

## 🧪 Testing

```bash
cd edge/
node test/test_fallback.js
```

Tests cover:
- ✓ Primary success uses primary
- ✓ Fallback when primary fails before tokens
- ✓ Auth errors NOT triggering fallback
- ✓ Streaming cannot fallback mid-stream
- ✓ All providers failing → aggregate error
- ✓ Cost-aware ordering (Grok < Gemini < GPT)
- ✓ Fixed-order mode respects user input

## 📊 Cost optimization tips

1. **Cache system prompt**: Claude prompt caching gives 90% discount cho repeated content
2. **Use Haiku/budget tiers** cho simple tasks, Opus chỉ cho complex reasoning
3. **Set lower `maxTokens`** — limits output cost (output 5x more expensive than input)
4. **Monitor `fallback_chain.used`** — nếu hay fall xuống fallbacks → primary có issue, switch

## 🔒 Security

- API keys ONLY in env vars (never client-side)
- CORS configurable per deployment
- Rate limiting: add Cloudflare/Vercel rate limit rules at platform level
- Validate input client-side AND server-side (handler.js validates)

## 🚧 Limitations

- Edge runtime: 10 MB memory, 30s execution time (Vercel) / 50ms CPU (CF Workers free tier)
- No persistent state (use KV/Durable Objects nếu cần)
- Mid-stream fallback NOT supported (architecture limitation)

## 📦 Deployment checklist

- [ ] All 4 API keys set as secrets (not vars)
- [ ] CORS origin restricted to your frontend domain (not `*` in prod)
- [ ] Region set to Singapore/HK cho VN users
- [ ] Test `/api/providers` returns expected order
- [ ] Test chat with valid key → success
- [ ] Test với invalid Claude key → should fallback to grok/gemini
- [ ] Monitor first 100 requests cho unexpected fallbacks
# tohong-back
