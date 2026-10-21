import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/shared/errors.js";
import type { TextBlock, Translation } from "../src/shared/protocol.js";
import { ModelProviders, parseTranslations } from "../src/host/providers.js";
import type { Settings } from "../src/host/settings.js";
import { TranslationPreviewParser } from "../src/host/stream-translations.js";

const blocks: TextBlock[] = [
  { id: "first", text: "Hello world." },
  { id: "second", text: "A second paragraph." },
];

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    provider: "chatgpt",
    chatgptModel: "test-model",
    customBaseUrl: "https://example.test/v1",
    customModel: "custom-model",
    apiKey: "",
    revision: "settings-test",
    ...overrides,
  };
}

test("preparation uses only the selected origin without credentials or a model request", async () => {
  const origins: string[] = [];
  const signal = new AbortController().signal;
  const providers = new ModelProviders(
    { accessToken: async () => { throw new Error("must not read tokens during preparation"); } },
    async () => { throw new Error("must not call models during preparation"); },
    "https://api.test.invalid/v1",
    async (origin, currentSignal) => {
      assert.equal(currentSignal, signal);
      origins.push(origin);
      return true;
    },
  );
  assert.equal(await providers.prepare(settings(), signal), true);
  assert.equal(await providers.prepare(settings({ provider: "custom", apiKey: "secret" }), signal), true);
  assert.deepEqual(origins, ["https://api.test.invalid", "https://example.test"]);
  assert.equal(await providers.prepare(settings({ chatgptModel: "" }), signal), false);
  assert.equal(await providers.prepare(settings({ provider: "custom", customModel: "" }), signal), false);
  assert.equal(origins.length, 2);
});

function expectCode(code: string, absent = "") {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    if (absent) assert.doesNotMatch(error.message, new RegExp(absent));
    return true;
  };
}

function byteChunks(text: string, sizes: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const end = Math.min(bytes.length, offset + sizes[index % sizes.length]!);
    chunks.push(bytes.slice(offset, end));
    offset = end;
    index += 1;
  }
  return chunks;
}

function chunkedResponse(text: string, sizes = [1, 2, 7, 3, 11]): Response {
  const chunks = byteChunks(text, sizes);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function event(value: unknown, ending = "\r\n\r\n"): string {
  return `data: ${JSON.stringify(value)}${ending}`;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function gatedResponse(contentType = "text/event-stream") {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
  }), { status: 200, headers: { "content-type": contentType } });
  const enqueue = (text: string, oneByteChunks = false) => {
    const bytes = new TextEncoder().encode(text);
    if (oneByteChunks) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    } else controller.enqueue(bytes);
  };
  return { response, controller, enqueue };
}

test("ChatGPT SSE survives arbitrary byte boundaries and accepts output only after response.completed", async () => {
  const finalText = JSON.stringify([
    { id: "first", text: "你好，世界。" },
    { id: "second", text: "第二段。" },
  ]);
  const stream = [
    event({ type: "response.output_text.delta", delta: "discarded partial" }),
    event({ type: "response.completed", response: {
      output: [{ content: [{ type: "output_text", text: finalText }] }],
    } }),
  ].join("");
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const providers = new ModelProviders(
    { accessToken: async () => "chatgpt-secret" },
    async (input, init) => {
      requests.push({ url: String(input), init });
      return chunkedResponse(stream);
    },
    "https://api.test.invalid/v1",
  );

  assert.deepEqual(await providers.translate(settings(), blocks, new AbortController().signal), [
    { id: "first", text: "你好，世界。" },
    { id: "second", text: "第二段。" },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "https://api.test.invalid/v1/responses");
  const request = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
  assert.equal(request.stream, true);
  assert.equal(request.store, false);
  assert.equal(request.model, "test-model");
  assert.equal(request.reasoning, undefined);
});

test("single ChatGPT text streams progress before response.completed and validates the final text", async () => {
  const gated = gatedResponse();
  const firstProgress = deferred<void>();
  const progress: string[] = [];
  let requestBody: Record<string, unknown> = {};
  const providers = new ModelProviders(
    { accessToken: async () => "token" },
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return gated.response;
    },
  );
  let settled = false;
  const result = providers.translate(settings(), [blocks[0]!], new AbortController().signal, (items) => {
    progress.push(items[0]!.text);
    firstProgress.resolve();
  }).finally(() => { settled = true; });

  gated.enqueue(event({ type: "response.output_text.delta", delta: "你" }), true);
  await firstProgress.promise;
  assert.equal(settled, false, "progress must arrive before the terminal event");
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.stream, true);
  assert.equal((requestBody.input as Array<{ content: string }>)[0]!.content, blocks[0]!.text);

  gated.enqueue(event({
    type: "response.completed",
    response: { output: [{ content: [{ type: "output_text", text: "你好" }] }] },
  }));
  gated.controller.close();
  assert.deepEqual(await result, [{ id: "first", text: "你好" }]);
  assert.deepEqual(progress, ["你", "你好"]);
});

test("single ChatGPT progress never turns an incomplete or refused response into a final result", async (t) => {
  for (const item of [
    {
      name: "incomplete",
      terminal: { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } },
      code: "INCOMPLETE_RESPONSE",
    },
    {
      name: "refusal",
      terminal: { type: "response.completed", response: { output: [{ content: [{ type: "refusal", refusal: "no" }] }] } },
      code: "INVALID_RESPONSE",
    },
  ]) {
    await t.test(item.name, async () => {
      const progress: string[] = [];
      const providers = new ModelProviders(
        { accessToken: async () => "token" },
        async () => chunkedResponse(
          event({ type: "response.output_text.delta", delta: "部分" }) + event(item.terminal),
          [1],
        ),
      );
      await assert.rejects(
        providers.translate(settings(), [blocks[0]!], new AbortController().signal,
          (items) => progress.push(items[0]!.text)),
        expectCode(item.code),
      );
      assert.deepEqual(progress, ["部分"]);
    });
  }
});

test("ChatGPT auto uses the fastest documented effort for a known model and manual choice is preserved", async (t) => {
  const finalText = JSON.stringify([
    { id: "first", text: "第一段" },
    { id: "second", text: "第二段" },
  ]);
  for (const item of [
    { name: "known model auto", model: "gpt-6-sol", choice: "auto" as const, effort: "none" },
    { name: "manual choice", model: "unknown-model", choice: "high" as const, effort: "high" },
  ]) {
    await t.test(item.name, async () => {
      let requestBody: Record<string, unknown> = {};
      const providers = new ModelProviders(
        { accessToken: async () => "token" },
        async (_input, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return chunkedResponse(event({
            type: "response.completed",
            response: { output: [{ content: [{ type: "output_text", text: finalText }] }] },
          }));
        },
      );
      await providers.translate(settings({
        chatgptModel: item.model,
        chatgptReasoningEffort: item.choice,
      }), blocks, new AbortController().signal);
      assert.deepEqual(requestBody.reasoning, { effort: item.effort });
      assert.equal(requestBody.service_tier, undefined);
    });
  }
});

test("model list falls back to slug, reports known efforts, caches by token partition, and rejects an empty catalog", async () => {
  let token = "account-one-token";
  let calls = 0;
  const providers = new ModelProviders(
    { accessToken: async () => token },
    async () => {
      calls += 1;
      return Response.json({ models: [
        { visibility: "list", slug: "gpt-6.1-sol", display_name: "" },
        { visibility: "hidden", slug: "hidden-model", display_name: "Hidden" },
      ] });
    },
  );

  const first = await providers.listModels();
  assert.deepEqual(first, [{
    id: "gpt-6.1-sol",
    name: "gpt-6.1-sol",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
  }]);
  assert.deepEqual(await providers.listModels(), first);
  assert.equal(calls, 1);

  token = "account-two-token";
  await providers.listModels();
  assert.equal(calls, 2);

  const empty = new ModelProviders(
    { accessToken: async () => "token" },
    async () => Response.json({ models: [{ visibility: "hidden", slug: "hidden" }] }),
  );
  await assert.rejects(empty.listModels(), expectCode("INVALID_RESPONSE"));
});

test("ChatGPT stream rejects failed, incomplete, and EOF-before-completed responses", async (t) => {
  const cases = [
    {
      name: "failed usage limit",
      body: event({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } }),
      code: "LIMIT_REACHED",
    },
    {
      name: "incomplete",
      body: event({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }),
      code: "PROVIDER_ERROR",
    },
    {
      name: "EOF after deltas and DONE",
      body: event({ type: "response.output_text.delta", delta: "[]" }) + "data: [DONE]\r\n\r\n",
      code: "INCOMPLETE_RESPONSE",
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const providers = new ModelProviders(
        { accessToken: async () => "token" },
        async () => chunkedResponse(item.body, [2, 1, 5]),
      );
      await assert.rejects(
        providers.translate(settings(), blocks, new AbortController().signal),
        expectCode(item.code),
      );
    });
  }
});

test("provider errors never expose echoed request secrets", async () => {
  const secret = "private-token-do-not-return";
  const providers = new ModelProviders(
    { accessToken: async () => secret },
    async () => Response.json({
      error: { code: "server_error", message: `request contained ${secret}` },
      request: { authorization: `Bearer ${secret}` },
    }, { status: 500 }),
  );

  await assert.rejects(
    providers.translate(settings(), blocks, new AbortController().signal),
    expectCode("PROVIDER_ERROR", secret),
  );
});

test("translation JSON rejects missing, unknown, and duplicate paragraph IDs", () => {
  const invalid = [
    JSON.stringify([{ id: "first", text: "一" }]),
    JSON.stringify([{ id: "first", text: "一" }, { id: "unknown", text: "二" }]),
    JSON.stringify([{ id: "first", text: "一" }, { id: "first", text: "二" }]),
  ];
  for (const value of invalid) {
    assert.throws(() => parseTranslations(value, blocks), expectCode("INVALID_RESPONSE"));
  }
});

test("custom provider sends one non-streaming Chat Completions request with the expected shape", async () => {
  let authCalled = false;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const providers = new ModelProviders(
    { accessToken: async () => { authCalled = true; return "unused"; } },
    async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify([
            { id: "first", text: "第一段" },
            { id: "second", text: "第二段" },
          ]) },
        }],
      });
    },
  );

  const result = await providers.translate(settings({
    provider: "custom",
    customBaseUrl: "https://custom.test/v1",
    customModel: "local-model",
    apiKey: "custom-secret",
    customReasoningEffort: "minimal",
  }), blocks, new AbortController().signal);

  assert.deepEqual(result.map((entry) => entry.id), ["first", "second"]);
  assert.equal(authCalled, false);
  assert.equal(capturedUrl, "https://custom.test/v1/chat/completions");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("authorization"), "Bearer custom-secret");
  const body = JSON.parse(String(capturedInit?.body)) as {
    model: string;
    stream: boolean;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, "local-model");
  assert.equal(body.stream, false);
  assert.equal((body as Record<string, unknown>).reasoning_effort, "minimal");
  assert.deepEqual(body.messages.map((message) => message.role), ["system", "user"]);
  assert.deepEqual(JSON.parse(body.messages[1]!.content), blocks);
});

test("single custom text streams UTF-8 progress before finish_reason stop", async () => {
  const gated = gatedResponse();
  const firstProgress = deferred<void>();
  const progress: string[] = [];
  let requestBody: Record<string, unknown> = {};
  const providers = new ModelProviders(
    { accessToken: async () => "unused" },
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return gated.response;
    },
  );
  let settled = false;
  const result = providers.translate(
    settings({ provider: "custom" }), [blocks[0]!], new AbortController().signal,
    (items) => { progress.push(items[0]!.text); firstProgress.resolve(); },
  ).finally(() => { settled = true; });

  gated.enqueue(event({ choices: [{ delta: { content: "中" }, finish_reason: null }] }), true);
  await firstProgress.promise;
  assert.equal(settled, false);
  assert.equal(requestBody.stream, true);
  assert.equal((requestBody.messages as Array<{ content: string }>)[1]!.content, blocks[0]!.text);

  gated.enqueue(event({ choices: [{ delta: { content: "文" }, finish_reason: null }] }), true);
  gated.enqueue(event({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\r\n\r\n");
  gated.controller.close();
  assert.deepEqual(await result, [{ id: "first", text: "中文" }]);
  assert.deepEqual(progress, ["中", "中文"]);
});

test("single custom returns at finish_reason stop and cancels an SSE body that stays open", async () => {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const bodyCancelled = deferred<void>();
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    cancel() { bodyCancelled.resolve(); },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const providers = new ModelProviders(
    { accessToken: async () => "unused" },
    async () => response,
  );
  const caller = new AbortController();
  const timeout = setTimeout(() => {
    caller.abort();
    try { streamController.error(new Error("test timeout")); } catch { /* reader already cancelled */ }
  }, 1_000);
  try {
    const result = providers.translate(
      settings({ provider: "custom" }), [blocks[0]!], caller.signal, () => undefined,
    );
    streamController.enqueue(new TextEncoder().encode(event({
      choices: [{ delta: { content: "终止译文" }, finish_reason: "stop" }],
    })));
    assert.deepEqual(await result, [{ id: "first", text: "终止译文" }]);
    await bodyCancelled.promise;
  } finally {
    clearTimeout(timeout);
  }
});

test("single custom stream cancellation aborts without retrying", async () => {
  const gated = gatedResponse();
  const firstProgress = deferred<void>();
  const caller = new AbortController();
  let calls = 0;
  const providers = new ModelProviders(
    { accessToken: async () => "unused" },
    async (_input, init) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => gated.controller.error(init.signal?.reason), { once: true });
      return gated.response;
    },
  );
  const result = providers.translate(
    settings({ provider: "custom" }), [blocks[0]!], caller.signal,
    () => firstProgress.resolve(),
  );
  gated.enqueue(event({ choices: [{ delta: { content: "首" }, finish_reason: null }] }));
  await firstProgress.promise;
  caller.abort();
  await assert.rejects(result, expectCode("CANCELLED"));
  assert.equal(calls, 1);
});

test("single custom accepts JSON despite requesting stream and falls back only for an explicit unsupported stream parameter", async (t) => {
  await t.test("JSON compatibility response", async () => {
    let requestBody: Record<string, unknown> = {};
    const progress: string[] = [];
    const providers = new ModelProviders(
      { accessToken: async () => "unused" },
      async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "兼容译文" } }] });
      },
    );
    assert.deepEqual(await providers.translate(
      settings({ provider: "custom" }), [blocks[0]!], new AbortController().signal,
      (items) => progress.push(items[0]!.text),
    ), [{ id: "first", text: "兼容译文" }]);
    assert.equal(requestBody.stream, true);
    assert.deepEqual(progress, ["兼容译文"]);
  });

  await t.test("explicit unsupported parameter fallback", async () => {
    const streams: boolean[] = [];
    const providers = new ModelProviders(
      { accessToken: async () => "unused" },
      async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { stream: boolean };
        streams.push(body.stream);
        if (body.stream) {
          return Response.json({ error: {
            code: "unsupported_parameter", param: "stream", message: "stream is not supported",
          } }, { status: 400 });
        }
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: "回退译文" } }] });
      },
    );
    assert.deepEqual(await providers.translate(
      settings({ provider: "custom" }), [blocks[0]!], new AbortController().signal, () => undefined,
    ), [{ id: "first", text: "回退译文" }]);
    assert.deepEqual(streams, [true, false]);
  });

  await t.test("generic 400 is not retried", async () => {
    let calls = 0;
    const providers = new ModelProviders(
      { accessToken: async () => "unused" },
      async () => {
        calls += 1;
        return Response.json({ error: { code: "invalid_request", message: "bad input" } }, { status: 400 });
      },
    );
    await assert.rejects(providers.translate(
      settings({ provider: "custom" }), [blocks[0]!], new AbortController().signal, () => undefined,
    ), expectCode("INVALID_CONFIG"));
    assert.equal(calls, 1);
  });
});

test("custom auto omits reasoning_effort for third-party compatibility", async () => {
  let requestBody: Record<string, unknown> = {};
  const providers = new ModelProviders(
    { accessToken: async () => "unused" },
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify([
          { id: "first", text: "第一段" }, { id: "second", text: "第二段" },
        ]) },
      }] });
    },
  );
  await providers.translate(settings({ provider: "custom", customReasoningEffort: "auto" }), blocks,
    new AbortController().signal);
  assert.equal(requestBody.reasoning_effort, undefined);
});

test("custom provider requires a normal stop finish reason", async () => {
  const providers = new ModelProviders(
    { accessToken: async () => "unused" },
    async () => Response.json({
      choices: [{ finish_reason: "length", message: { content: "[]" } }],
    }),
  );
  await assert.rejects(
    providers.translate(settings({ provider: "custom" }), blocks, new AbortController().signal),
    expectCode("INCOMPLETE_RESPONSE"),
  );
});

test("incremental JSON previews decode complete escapes and retain all expected ids", () => {
  const parser = new TranslationPreviewParser(blocks);
  assert.deepEqual(parser.append('[{"id":"first","text":"hello \\uD83D'), [{ id: "first", text: "hello " }]);
  assert.equal(parser.append('\\uDE'), undefined, "an unfinished escape is not preview text");
  assert.deepEqual(parser.append('00\\n\\\"quote\\\"'), [{ id: "first", text: 'hello 😀\n"quote"' }]);
  assert.deepEqual(parser.append('"},{"text":"第二段","id":"second"}]'), [
    { id: "first", text: 'hello 😀\n"quote"' }, { id: "second", text: "第二段" },
  ]);
});

test("incremental parser accepts any character split and waits for a recognized complete id", () => {
  const parser = new TranslationPreviewParser(blocks);
  assert.equal(parser.append('[{"text":"second \\\\ slash","id":"seco'), undefined);
  assert.deepEqual(parser.append('nd"},'), [{ id: "second", text: "second \\ slash" }]);
  let latest: Translation[] | undefined;
  for (const character of '{"id":"first","text":"一\\t二\\u4e09"}]') latest = parser.append(character) ?? latest;
  assert.deepEqual(latest, [{ id: "first", text: "一\t二三" }, { id: "second", text: "second \\ slash" }]);
  const fenced = new TranslationPreviewParser(blocks);
  assert.equal(fenced.append('```json\n[{"id":"first","text":"no preview"}]\n```'), undefined);
});

test("incremental parser rejects unknown ids, duplicate keys and ids, broken escapes and structural text", async (t) => {
  for (const text of [
    '[{"id":"other","text":"unknown"}]',
    '[{"id":"first","id":"first","text":"duplicate key"}]',
    '[{"id":"first","text":"one"},{"id":"first","text":"duplicate id"}]',
    '[{"id":"first","text":"bad\\x"}]',
    '[{"id":"first","text":"bad\\u00xx"}]',
    '[{"id":"first","text":"bad\nraw control"}]',
    '[{"id":"first","text":123}]',
    '[{"id":"first","text":"one","extra":"ignored?"}]',
    '[{"id":"first","text":"one"},]',
  ]) await t.test(text, () => assert.throws(() => new TranslationPreviewParser(blocks).append(text), expectCode("INVALID_RESPONSE")));
});

test("multi-paragraph providers stream cumulative text before terminal and observe only supplied usage", async (t) => {
  for (const provider of ["chatgpt", "custom"] as const) await t.test(provider, async () => {
    const gated = gatedResponse();
    const first = deferred();
    const second = deferred();
    const snapshots: Translation[][] = [];
    const observed: Array<{ stage: string; values?: Record<string, number | boolean> }> = [];
    let requestBody: Record<string, unknown> = {};
    const providers = new ModelProviders({ accessToken: async () => "token" }, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return gated.response;
    });
    let settled = false;
    const result = providers.translate(settings({ provider, targetLanguage: "ja" }), blocks, new AbortController().signal,
      (items) => { snapshots.push(items); (items.length === 1 ? first : second).resolve(); },
      (stage, values) => observed.push({ stage, values })).finally(() => { settled = true; });
    const delta = (text: string) => provider === "chatgpt"
      ? { type: "response.output_text.delta", delta: text }
      : { choices: [{ delta: { content: text }, finish_reason: null }] };
    gated.enqueue(event(delta('[{"id":"first","text":"最初')), true);
    await first.promise;
    assert.equal(settled, false);
    assert.deepEqual(snapshots[0], [{ id: "first", text: "最初" }]);
    gated.enqueue(event(delta('の段落"},{"id":"second","text":"次の')), true);
    await second.promise;
    assert.equal(settled, false);
    assert.deepEqual(snapshots.at(-1), [{ id: "first", text: "最初の段落" }, { id: "second", text: "次の" }]);
    gated.enqueue(event(delta('段落"}]')));
    const usage = provider === "chatgpt"
      ? { input_tokens: 12, output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 } }
      : { prompt_tokens: 12, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 0 } };
    gated.enqueue(event(provider === "chatgpt"
      ? { type: "response.completed", response: { usage } }
      : { choices: [{ delta: {}, finish_reason: "stop" }], usage }));
    assert.deepEqual(await result, [{ id: "first", text: "最初の段落" }, { id: "second", text: "次の段落" }]);
    assert.equal(requestBody.stream, true);
    const prompt = provider === "chatgpt" ? requestBody.instructions : (requestBody.messages as Array<{ content: string }>)[0]?.content;
    assert.match(String(prompt), /into Japanese/);
    assert.match(String(prompt), /JSON array/);
    assert.deepEqual(observed.map(({ stage }) => stage), [
      ...(provider === "chatgpt" ? ["auth.start", "auth.end"] : []),
      "request.dispatch", "request.headers", "first.delta", "terminal",
    ]);
    assert.deepEqual(observed.at(-1)?.values, { completed: true, inputTokens: 12, outputTokens: 8, reasoningTokens: 0 });
    assert.equal(observed.at(-1)?.values?.cachedTokens, undefined, "absent tokens remain unknown");
  });
});

test("multi-paragraph previews cannot bypass full-batch validation or provider terminal", async (t) => {
  for (const provider of ["chatgpt", "custom"] as const) {
    for (const terminal of [true, false]) await t.test(`${provider} terminal=${terminal}`, async () => {
      let previews = 0;
      const incompleteBatch = '[{"id":"first","text":"visible preview"}]';
      const stream = event(provider === "chatgpt"
        ? { type: "response.output_text.delta", delta: incompleteBatch }
        : { choices: [{ delta: { content: incompleteBatch }, finish_reason: null }] }) +
        (terminal ? event(provider === "chatgpt"
          ? { type: "response.completed", response: {} }
          : { choices: [{ delta: {}, finish_reason: "stop" }] }) : "");
      const providers = new ModelProviders({ accessToken: async () => "token" }, async () => chunkedResponse(stream));
      await assert.rejects(providers.translate(settings({ provider }), blocks, new AbortController().signal,
        () => { previews += 1; }), expectCode(terminal ? "INVALID_RESPONSE" : "INCOMPLETE_RESPONSE"));
      assert.ok(previews > 0, "preview is observable before final failure");
    });
  }
});

test("multi-paragraph cancellation aborts active streams and never retries", async (t) => {
  for (const provider of ["chatgpt", "custom"] as const) await t.test(provider, async () => {
    const gated = gatedResponse();
    const progress = deferred();
    const controller = new AbortController();
    let calls = 0;
    let previews = 0;
    const providers = new ModelProviders({ accessToken: async () => "token" }, async (_input, init) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => gated.controller.error(init.signal!.reason), { once: true });
      return gated.response;
    });
    const result = providers.translate(settings({ provider }), blocks, controller.signal, () => { previews += 1; progress.resolve(); });
    const check = assert.rejects(result, expectCode("CANCELLED"));
    gated.enqueue(event(provider === "chatgpt"
      ? { type: "response.output_text.delta", delta: '[{"id":"first","text":"one' }
      : { choices: [{ delta: { content: '[{"id":"first","text":"one' }, finish_reason: null }] }));
    await progress.promise;
    controller.abort();
    await check;
    assert.equal(calls, 1);
    assert.equal(previews, 1);
  });
});

test("multi-paragraph custom fallback requires explicit unsupported stream and validates the fallback batch", async (t) => {
  for (const unsupported of [true, false]) await t.test(`explicit=${unsupported}`, async () => {
    const streams: boolean[] = [];
    const providers = new ModelProviders({ accessToken: async () => "unused" }, async (_input, init) => {
      streams.push(JSON.parse(String(init?.body)).stream as boolean);
      if (streams.length === 1) return Response.json({ error: unsupported
        ? { param: "stream", message: "unsupported" } : { message: "bad request" } }, { status: 400 });
      return Response.json({ choices: [{ finish_reason: "stop", message: {
        content: JSON.stringify([{ id: "second", text: "二" }, { id: "first", text: "一" }]),
      } }] });
    });
    const result = providers.translate(settings({ provider: "custom" }), blocks, new AbortController().signal, () => undefined);
    if (unsupported) {
      assert.deepEqual(await result, [{ id: "first", text: "一" }, { id: "second", text: "二" }]);
      assert.deepEqual(streams, [true, false]);
    } else {
      await assert.rejects(result, expectCode("INVALID_CONFIG"));
      assert.deepEqual(streams, [true]);
    }
  });
});

test("provider observer failures do not affect output and omitted token usage stays absent", async () => {
  const observed: Array<Record<string, number | boolean> | undefined> = [];
  const text = JSON.stringify([{ id: "first", text: "one" }, { id: "second", text: "two" }]);
  let prompt = "";
  const providers = new ModelProviders({ accessToken: async () => "unused" }, async (_input, init) => {
    prompt = JSON.parse(String(init?.body)).messages[0].content as string;
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: text } }] });
  });
  assert.equal((await providers.translate(settings({ provider: "custom" }), blocks, new AbortController().signal,
    undefined, (stage, values) => { if (stage === "terminal") observed.push(values); throw new Error("diagnostic failure"); })).length, 2);
  assert.match(prompt, /into Simplified Chinese/);
  assert.deepEqual(observed, [{ completed: true }]);
});

test("a stream parameter error without explicit incompatibility does not retry a multi-paragraph request", async () => {
  let calls = 0;
  const providers = new ModelProviders({ accessToken: async () => "unused" }, async () => {
    calls += 1;
    return Response.json({ error: { param: "stream", message: "Invalid value" } }, { status: 400 });
  });
  await assert.rejects(providers.translate(settings({ provider: "custom" }), blocks,
    new AbortController().signal, () => undefined), expectCode("INVALID_CONFIG"));
  assert.equal(calls, 1);
});
