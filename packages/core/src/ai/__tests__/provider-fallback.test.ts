import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { LLMClient } from '../llm-client.js';

const answer = (content = 'A red circle.', model = 'glm-5.3-flash:cloud') => new Response(JSON.stringify({
  model, choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 20 },
}), { status: 200 });

function client() {
  return new LLMClient({
    provider: 'ollama-cloud', apiKey: 'ollama-test',
    textModel: 'glm-5.3-flash:cloud', visionModel: 'glm-5.3-flash:cloud',
    maxRetries: 0, timeoutMs: 20,
    fallback: {
      provider: 'openai', apiKey: 'openai-test',
      textModel: 'gpt-5.6-luna', visionModel: 'gpt-5.6-luna',
      reasoningEffort: 'high', reasoningTokenBudget: 8192, maxRetries: 0,
    },
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Ollama to OpenAI failover', () => {
  it('uses only GLM on success, including when retries are zero', async () => {
    const fetcher = vi.fn().mockResolvedValue(answer());
    vi.stubGlobal('fetch', fetcher);
    expect(await client().chat({ messages: [{ role: 'user', content: 'Describe it' }] })).toBe('A red circle.');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://ollama.com/v1/chat/completions');
  });

  it.each([401, 404, 429, 503])('fails over on HTTP %s with separate credentials and Luna parameters', async (status) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('unavailable', { status }))
      .mockResolvedValueOnce(answer('Fixed HTML', 'gpt-5.6-luna'));
    vi.stubGlobal('fetch', fetcher);
    const llm = client();
    expect(await llm.chat({ messages: [{ role: 'user', content: 'Fix HTML' }], maxTokens: 500 })).toBe('Fixed HTML');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer ollama-test');
    const [url, request] = fetcher.mock.calls[1];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer openai-test');
    expect(JSON.parse(request.body)).toEqual({
      model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'Fix HTML' }],
      max_completion_tokens: 8692, reasoning_effort: 'high', stream: false,
    });
    expect(llm.usage).toEqual([expect.objectContaining({ provider: 'openai', model: 'gpt-5.6-luna', outputTokens: 20 })]);
  });

  it('preserves image bytes and context in fallback', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('network unavailable')).mockResolvedValueOnce(answer());
    vi.stubGlobal('fetch', fetcher);
    await client().vision({ image: { kind: 'bytes', bytes: Buffer.from('image'), mimeType: 'image/png' }, prompt: 'Describe for a biology lesson' });
    const first = JSON.parse(fetcher.mock.calls[0][1].body);
    const second = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(second.messages).toEqual(first.messages);
    expect(second.messages[0].content[0].image_url.url).toBe('data:image/png;base64,aW1hZ2U=');
    expect(second.model).toBe('gpt-5.6-luna');
  });

  it('fails over on timeouts', async () => {
    const fetcher = vi.fn().mockImplementationOnce((_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
    })).mockResolvedValueOnce(answer());
    vi.stubGlobal('fetch', fetcher);
    expect(await client().chat({ messages: [] })).toBe('A red circle.');
  });

  it.each([
    { choices: [{ message: { content: '', reasoning_content: 'Private reasoning' } }] },
    { choices: [{ message: { content: 'Incomplete HTML' }, finish_reason: 'length' }] },
  ])('never returns reasoning or truncated output as a fix', async (body) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body))).mockResolvedValueOnce(answer('Complete answer'));
    vi.stubGlobal('fetch', fetcher);
    expect(await client().chat({ messages: [] })).toBe('Complete answer');
  });

  it.each([400, 403, 422])('does not fail over on rejected requests (%s)', async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response('rejected', { status }));
    vi.stubGlobal('fetch', fetcher);
    await expect(client().chat({ messages: [] })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not send refusals to another provider', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { refusal: 'Declined' } }] })));
    vi.stubGlobal('fetch', fetcher);
    await expect(client().chat({ messages: [] })).rejects.toThrow('declined');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('reports failure when both providers fail without looping', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(client().chat({ messages: [] })).rejects.toThrow('failed after 1 attempts');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not leak primary environment credentials, endpoints or models into the fallback', async () => {
    vi.stubEnv('REMEDY_LLM_PROVIDER', 'ollama-cloud');
    vi.stubEnv('REMEDY_LLM_BASE_URL', 'https://ollama.com/v1');
    vi.stubEnv('REMEDY_LLM_API_KEY', 'primary-only');
    vi.stubEnv('REMEDY_TEXT_MODEL', 'glm-5.3-flash:cloud');
    vi.stubEnv('REMEDY_VISION_MODEL', 'glm-5.3-flash:cloud');
    vi.stubEnv('REMEDY_FALLBACK_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', 'fallback-only');
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('unauthorized', { status: 401 })).mockResolvedValueOnce(answer());
    vi.stubGlobal('fetch', fetcher);
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
    await new LLMClient({ maxRetries: 1 }).vision({ image: { kind: 'url', url: 'data:image/png;base64,' + image.toString('base64') }, prompt: 'Alt text' });
    expect(fetcher.mock.calls[1][0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('Bearer fallback-only');
    expect(JSON.parse(fetcher.mock.calls[1][1].body).model).toBe('gpt-5.6-luna');
  });
});
