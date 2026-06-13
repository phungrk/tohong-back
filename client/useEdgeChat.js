/**
 * useEdgeChat — React hook để stream từ edge function.
 *
 * Usage:
 *   const { messages, sendMessage, isStreaming, currentProvider, fallbackInfo } = useEdgeChat({
 *     endpoint: '/api/chat',
 *     systemPrompt: 'You are Lead Planner...',
 *   });
 *
 *   sendMessage('Tôi muốn cưới truyền thống nhưng modern');
 *
 * SSE events handled:
 * - provider_attempt: track which provider is trying
 * - chunk: append text to current message
 * - meta: capture final usage + fallback chain
 * - error: surface error to UI
 * - done: stream complete
 */

import { useState, useCallback, useRef } from 'react';

function normalizeAssistantText(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}(?:[-*+•][ \t]+|\d{1,2}[.)][ \t]+)/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function useEdgeChat({ endpoint = '/api/chat', systemPrompt, maxTokens = 1024 } = {}) {
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentProvider, setCurrentProvider] = useState(null);
  const [fallbackInfo, setFallbackInfo] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const sendMessage = useCallback(async (userText) => {
    if (!userText?.trim() || isStreaming) return;

    setError(null);
    setFallbackInfo(null);

    // Add user message + empty assistant placeholder
    const newMessages = [
      ...messages,
      { role: 'user', content: userText },
      { role: 'assistant', content: '', streaming: true },
    ];
    setMessages(newMessages);
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          messages: newMessages
            .filter((m) => m.role !== 'assistant' || !m.streaming) // exclude placeholder
            .map((m) => ({ role: m.role, content: m.content })),
          systemPrompt,
          maxTokens,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${response.status}`);
      }

      // Parse SSE
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let assistantContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const rawEvent of events) {
          if (!rawEvent.trim()) continue;
          const lines = rawEvent.split('\n');
          const eventLine = lines.find((l) => l.startsWith('event: '));
          const dataLine = lines.find((l) => l.startsWith('data: '));
          if (!dataLine) continue;

          const eventName = eventLine?.slice(7).trim() || 'message';
          const data = JSON.parse(dataLine.slice(6));

          if (eventName === 'provider_attempt') {
            setCurrentProvider({
              name: data.provider,
              model: data.model,
              attempt: data.attempt,
              total: data.total_attempts,
            });
          } else if (eventName === 'chunk') {
            assistantContent += data.text;
            const content = normalizeAssistantText(assistantContent);
            // Update last message (the streaming assistant one)
            setMessages((prev) => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last?.role === 'assistant') {
                updated[updated.length - 1] = { ...last, content, rawContent: assistantContent };
              }
              return updated;
            });
          } else if (eventName === 'meta') {
            setFallbackInfo({
              used: data.fallback_chain?.used,
              usedModel: data.fallback_chain?.used_model,
              attempts: data.fallback_chain?.attempts,
              failedProviders: data.fallback_chain?.failed_providers || [],
              totalLatencyMs: data.fallback_chain?.total_latency_ms,
              usage: data.usage,
            });
          } else if (eventName === 'error') {
            throw new Error(data.message || 'Unknown error from provider chain');
          } else if (eventName === 'done') {
            // Stream finished cleanly
          }
        }
      }

      // Mark streaming complete
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant') {
          updated[updated.length - 1] = { ...last, streaming: false };
        }
        return updated;
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        setError(null); // user cancelled
      } else {
        console.error('[useEdgeChat]', err);
        setError(err.message);
        // Mark last assistant message as failed
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = {
              ...last,
              streaming: false,
              error: err.message,
            };
          }
          return updated;
        });
      }
    } finally {
      setIsStreaming(false);
      setCurrentProvider(null);
      abortRef.current = null;
    }
  }, [endpoint, isStreaming, messages, systemPrompt, maxTokens]);

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    setMessages([]);
    setError(null);
    setFallbackInfo(null);
    setCurrentProvider(null);
  }, []);

  return {
    messages,
    sendMessage,
    cancel,
    reset,
    isStreaming,
    currentProvider,
    fallbackInfo,
    error,
  };
}
