import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelProviders } from "../src/host/providers.js";
import { publicError } from "../src/shared/errors.js";

const auth = { accessToken: async () => "fixture-token" };

test("model catalog transport failures produce an actionable, credential-free error", async () => {
  const fetcher: typeof fetch = async () => {
    throw new TypeError("fetch failed: Bearer fixture-secret", {
      cause: Object.assign(new Error("certificate detail: fixture-secret"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
    });
  };
  await assert.rejects(new ModelProviders(auth, fetcher).listModels(), (error) => {
    const result = publicError(error);
    assert.equal(result.code, "NETWORK_ERROR");
    assert.match(result.message, /代理/);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret|Bearer|certificate detail/);
    return true;
  });
});

test("model catalog cancellation is not reported as an internal failure", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private cancellation reason"));
  const fetcher: typeof fetch = async (_input, init) => {
    init?.signal?.throwIfAborted();
    throw new Error("unreachable");
  };
  await assert.rejects(new ModelProviders(auth, fetcher).listModels(controller.signal), (error) => {
    assert.equal(publicError(error).code, "CANCELLED");
    assert.doesNotMatch(publicError(error).message, /private/);
    return true;
  });
});

test("model catalog preserves authentication and response validation errors", async () => {
  for (const [status, body, code] of [
    [401, {}, "AUTH_REQUIRED"],
    [200, { data: [] }, "INVALID_RESPONSE"],
    [200, { models: [] }, "INVALID_RESPONSE"],
  ] as const) {
    const fetcher: typeof fetch = async () => Response.json(body, { status });
    await assert.rejects(new ModelProviders(auth, fetcher).listModels(), (error) => {
      assert.equal(publicError(error).code, code);
      return true;
    });
  }
});
