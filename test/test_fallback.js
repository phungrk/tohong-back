/**
 * Tests cho CostAwareFallbackOrchestrator.
 *
 * Run: node test/test_fallback.js
 */

import { BaseProvider, ProviderError } from '../providers/base.js';
import { CostAwareFallbackOrchestrator } from '../lib/orchestrator.js';

// === Mock providers ===

class MockSuccess extends BaseProvider {
  constructor(name, model) {
    super({ apiKey: 'mock', model });
    this._name = name;
  }
  get name() { return this._name; }
  async *stream() {
    yield 'Hello ';
    yield 'from ';
    yield this._name;
    return {
      usage: { input_tokens: 10, output_tokens: 3 },
      model: this.model,
      provider: this.name,
      finish_reason: 'stop',
    };
  }
}

class MockFail extends BaseProvider {
  constructor(name, model, category = 'server_error') {
    super({ apiKey: 'mock', model });
    this._name = name;
    this._category = category;
  }
  get name() { return this._name; }
  async *stream() {
    throw new ProviderError(this.name, this._category, 'Simulated failure');
    yield; // unreachable
  }
}

class MockMidStreamFail extends BaseProvider {
  constructor(name, model) {
    super({ apiKey: 'mock', model });
    this._name = name;
  }
  get name() { return this._name; }
  async *stream() {
    yield 'Some text ';
    yield 'then... ';
    throw new ProviderError(this.name, 'server_error', 'Failed mid-stream');
  }
}

class MockFailOnce extends BaseProvider {
  constructor(name, model) {
    super({ apiKey: 'mock', model });
    this._name = name;
    this.calls = 0;
  }
  get name() { return this._name; }
  async *stream() {
    this.calls++;
    if (this.calls === 1) {
      throw new ProviderError(this.name, 'server_error', 'Temporary outage');
    }
    yield 'Recovered';
    return {
      usage: { input_tokens: 10, output_tokens: 1 },
      model: this.model,
      provider: this.name,
      finish_reason: 'stop',
    };
  }
}

// === Test runner ===

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`     ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 3).join('\n'));
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg} Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'Expected truthy');
}

async function collectStream(orch, params) {
  const events = [];
  try {
    for await (const e of orch.stream(params)) {
      events.push(e);
    }
    return { events, error: null };
  } catch (err) {
    return { events, error: err };
  }
}

// === Tests ===

async function main() {
  console.log('\n📋 CostAwareFallbackOrchestrator Tests\n');

  console.log('─ Basic streaming:');

  await test('Primary success → uses primary, no fallbacks', async () => {
    const orch = new CostAwareFallbackOrchestrator([
      new MockSuccess('claude', 'claude-opus-4-7'),
      new MockSuccess('gpt', 'gpt-5-mini'),
    ]);
    const { events, error } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assertEqual(error, null);
    const chunks = events.filter((e) => e.type === 'chunk');
    const meta = events.find((e) => e.type === 'meta');
    assertEqual(chunks.length, 3);
    assertEqual(chunks.map((c) => c.text).join(''), 'Hello from claude');
    assertEqual(meta.fallback_chain.used, 'claude');
    assertEqual(meta.fallback_chain.attempts, 1);
  });

  await test('Primary fails BEFORE tokens → fallback succeeds', async () => {
    const orch = new CostAwareFallbackOrchestrator([
      new MockFail('claude', 'claude-opus-4-7', 'rate_limit'),
      new MockSuccess('grok', 'grok-4.1-fast'),
    ]);
    const { events, error } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assertEqual(error, null);
    const meta = events.find((e) => e.type === 'meta');
    assertEqual(meta.fallback_chain.used, 'grok');
    assertEqual(meta.fallback_chain.attempts, 2);
    assertEqual(meta.fallback_chain.failed_providers[0].provider, 'claude');
  });

  await test('Streaming auth error does NOT trigger fallback', async () => {
    const orch = new CostAwareFallbackOrchestrator([
      new MockFail('claude', 'claude-opus-4-7', 'auth'),
      new MockSuccess('grok', 'grok-4.1-fast'),
    ]);
    const { events, error } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assertTrue(error !== null, 'Should throw');
    const attempts = events.filter((e) => e.type === 'provider_attempt');
    assertEqual(attempts.length, 1, 'Should not attempt grok after auth error');
    const errorEvents = events.filter((e) => e.type === 'error');
    assertEqual(errorEvents[0].category, 'auth');
  });

  await test('Streaming CANNOT fallback after first token', async () => {
    const orch = new CostAwareFallbackOrchestrator([
      new MockMidStreamFail('claude', 'claude-opus-4-7'),
      new MockSuccess('grok', 'grok-4.1-fast'),
    ]);
    const { events, error } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assertTrue(error !== null, 'Should throw error');
    const chunks = events.filter((e) => e.type === 'chunk');
    assertTrue(chunks.length > 0, 'Should yield chunks from claude before failing');
    const attempts = events.filter((e) => e.type === 'provider_attempt');
    assertEqual(attempts.length, 1, 'Should NOT try grok after streaming started');
    const errorEvents = events.filter((e) => e.type === 'error');
    assertEqual(errorEvents[0].mid_stream, true);
  });

  await test('All providers fail → comprehensive error', async () => {
    const orch = new CostAwareFallbackOrchestrator([
      new MockFail('claude', 'claude-opus-4-7', 'rate_limit'),
      new MockFail('gemini', 'gemini-3-flash', 'server_error'),
      new MockFail('grok', 'grok-4.1-fast', 'timeout'),
      new MockFail('gpt', 'gpt-5-mini', 'server_error'),
    ]);
    const { events, error } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assertTrue(error !== null);
    const errorEvents = events.filter((e) => e.type === 'error');
    assertEqual(errorEvents[0].errors.length, 4);
  });

  await test('Transient server error retries the same provider before fallback', async () => {
    const gemini = new MockFailOnce('gemini', 'gemini-2.5-flash');
    const orch = new CostAwareFallbackOrchestrator([gemini], {
      maxAttemptsPerProvider: 2,
    });
    const { events, error } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    assertEqual(error, null);
    assertEqual(gemini.calls, 2);
    const attempts = events.filter((e) => e.type === 'provider_attempt');
    assertEqual(attempts.length, 2);
    assertEqual(events.filter((e) => e.type === 'chunk').map((e) => e.text).join(''), 'Recovered');
  });

  console.log('\n─ Cost-aware ordering:');

  await test('Cost-aware mode: fallbacks sorted by cost ascending', async () => {
    // All 4 fail → see full sorted order
    // Claude primary, fallbacks: gpt (expensive), grok (cheap), gemini (medium)
    // Expected: claude → grok (cheapest) → gemini → gpt (most expensive)
    const providers = [
      new MockFail('claude', 'claude-opus-4-7', 'rate_limit'),
      new MockFail('gpt', 'gpt-5.2', 'rate_limit'),         // input 1.75, output 14
      new MockFail('grok', 'grok-4.1-fast', 'rate_limit'),  // input 0.20, output 0.50
      new MockFail('gemini', 'gemini-3-flash', 'rate_limit'), // input 0.50, output 3.00
    ];
    const orch = new CostAwareFallbackOrchestrator(providers, { strategy: 'cost_aware' });
    const { events } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    const attempts = events.filter((e) => e.type === 'provider_attempt').map((e) => e.provider);
    assertEqual(attempts, ['claude', 'grok', 'gemini', 'gpt']);
  });

  await test('Cost-aware: stops at first successful provider', async () => {
    // Grok is cheapest fallback → succeeds → gpt never attempted
    const providers = [
      new MockFail('claude', 'claude-opus-4-7', 'rate_limit'),
      new MockFail('gpt', 'gpt-5.2', 'rate_limit'),
      new MockSuccess('grok', 'grok-4.1-fast'),
      new MockSuccess('gemini', 'gemini-3-flash'),
    ];
    const orch = new CostAwareFallbackOrchestrator(providers, { strategy: 'cost_aware' });
    const { events } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    const attempts = events.filter((e) => e.type === 'provider_attempt').map((e) => e.provider);
    assertEqual(attempts, ['claude', 'grok']); // stop after grok success
    const meta = events.find((e) => e.type === 'meta');
    assertEqual(meta.fallback_chain.used, 'grok');
  });

  await test('Fixed-order mode: respects user-specified order', async () => {
    const providers = [
      new MockFail('claude', 'claude-opus-4-7', 'rate_limit'),
      new MockFail('gpt', 'gpt-5.2', 'rate_limit'),
      new MockFail('grok', 'grok-4.1-fast', 'rate_limit'),
      new MockSuccess('gemini', 'gemini-3-flash'),
    ];
    const orch = new CostAwareFallbackOrchestrator(providers, { strategy: 'fixed_order' });
    const { events } = await collectStream(orch, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    const attempts = events.filter((e) => e.type === 'provider_attempt').map((e) => e.provider);
    assertEqual(attempts, ['claude', 'gpt', 'grok', 'gemini']);
  });

  console.log('\n─ Plan introspection:');

  await test('getPlan() returns execution order', async () => {
    const orch = new CostAwareFallbackOrchestrator([
      new MockSuccess('claude', 'claude-opus-4-7'),
      new MockSuccess('grok', 'grok-4.1-fast'),
      new MockSuccess('gemini', 'gemini-3-flash'),
    ]);
    const plan = orch.getPlan();
    assertEqual(plan[0].role, 'primary');
    assertEqual(plan[0].name, 'claude');
    assertEqual(plan[1].role, 'fallback_by_cost');
    // grok cheaper than gemini → should be #2
    assertEqual(plan[1].name, 'grok');
    assertEqual(plan[2].name, 'gemini');
  });

  // Summary
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Total: ${passed + failed} · Passed: ${passed} · Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
