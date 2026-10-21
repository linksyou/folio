import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGPTAuth } from "../src/host/auth/index.js";
import { resolveEndpoints } from "../src/host/auth/oauth.js";
import { AppError } from "../src/shared/errors.js";

const issuer = "https://auth.test.invalid";
const clientId = "oaiapp_auth_test";
const subject = "auth-test-subject";
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";

function inputUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function gate() {
  return { started: deferred(), release: deferred() };
}

function expectCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, code);
    assert.match(error.message, /[\u3400-\u9fff]/u);
    return true;
  };
}

interface FixtureOptions {
  initialExpiresIn?: number;
  refreshFailure?: boolean;
  identityMode?: "valid" | "wrong_nonce" | "bad_signature";
  grantedScopes?: string;
  refreshJwksFailures?: number;
  refreshGate?: ReturnType<typeof gate>;
  authorizationGate?: ReturnType<typeof gate>;
  revokeFailure?: boolean;
  onRevoke?: (dataDir: string) => Promise<void> | void;
  openBrowser?: (url: string) => Promise<void>;
}

interface SavedState {
  activeProfileId?: string;
  profiles: Array<{
    id: string;
    state: string;
    clientId: string;
    subject?: string;
    scopes: string[];
    credentials?: { accessToken: string; refreshToken?: string };
    pendingRefresh?: { credentials: { accessToken: string; refreshToken?: string } };
  }>;
  pendingRegistrations: Array<{ id: string; clientId: string }>;
}

async function fixture(t: test.TestContext, options: FixtureOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "open-web-translator-auth-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const { privateKey: attackerKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "auth-test-key", use: "sig", alg: "RS256" };
  const endpoints = {
    issuer,
    authorization: `${issuer}/authorize`,
    token: `${issuer}/token`,
    jwks: `${issuer}/jwks`,
    revocation: `${issuer}/revoke`,
    resource: "https://api.openai.com/v1",
  };
  let authorization: URL | undefined;
  let refreshCount = 0;
  let revokeCount = 0;
  let refreshIssued = false;
  let remainingRefreshJwksFailures = options.refreshJwksFailures ?? 0;

  const identity = (nonce: string | undefined, signingKey: CryptoKey = privateKey) => new SignJWT({
    iss: issuer,
    aud: clientId,
    sub: subject,
    email: "reader@example.test",
    iat: Math.floor(Date.now() / 1_000),
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    ...(nonce ? { nonce } : {}),
  }).setProtectedHeader({ alg: "RS256", kid: "auth-test-key" }).sign(signingKey);

  const fetcher: typeof fetch = async (input, init) => {
    const url = inputUrl(input);
    if (url === `${issuer}/jwks`) {
      if (refreshIssued && remainingRefreshJwksFailures > 0) {
        remainingRefreshJwksFailures -= 1;
        return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      }
      return Response.json({ keys: [jwk] });
    }
    if (url === `${issuer}/token`) {
      const body = init?.body as URLSearchParams;
      if (body.get("grant_type") === "authorization_code") {
        assert.equal(body.get("client_id"), clientId);
        assert.equal(body.get("redirect_uri"), authorization?.searchParams.get("redirect_uri"));
        options.authorizationGate?.started.resolve();
        await options.authorizationGate?.release.promise;
        const requestedNonce = authorization?.searchParams.get("nonce") ?? undefined;
        const tokenNonce = options.identityMode === "wrong_nonce" ? `${requestedNonce}-wrong` : requestedNonce;
        const signingKey = options.identityMode === "bad_signature" ? attackerKey : privateKey;
        return Response.json({
          access_token: "initial-access-token",
          refresh_token: "initial-refresh-token",
          token_type: "Bearer",
          expires_in: options.initialExpiresIn ?? 3_600,
          scope: options.grantedScopes ?? scopes,
          id_token: await identity(tokenNonce, signingKey),
        });
      }
      refreshCount += 1;
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "initial-refresh-token");
      options.refreshGate?.started.resolve();
      await options.refreshGate?.release.promise;
      if (options.refreshFailure) return Response.json({ error: "invalid_grant" }, { status: 400 });
      refreshIssued = true;
      return Response.json({
        access_token: "rotated-access-token",
        refresh_token: "rotated-refresh-token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: options.grantedScopes ?? scopes,
        id_token: await identity(undefined),
      });
    }
    if (url === `${issuer}/revoke`) {
      revokeCount += 1;
      await options.onRevoke?.(dataDir);
      if (options.revokeFailure) throw new Error("revocation network unavailable");
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const callback = async (url: string, values: {
    state?: string;
    code?: string;
    error?: string;
  } = {}): Promise<Response> => {
    authorization = new URL(url);
    assert.equal(authorization.hostname, "auth.test.invalid");
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorization.searchParams.get("ext_agent_host_id") ?? "", /^urn:uuid:/);
    const target = new URL(authorization.searchParams.get("redirect_uri") ?? "");
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(target.pathname, "/auth/callback");
    target.searchParams.set("state", values.state ?? authorization.searchParams.get("state") ?? "");
    target.searchParams.set("client_id", clientId);
    if (values.error) target.searchParams.set("error", values.error);
    else target.searchParams.set("code", values.code ?? "one-time-code");
    return globalThis.fetch(target);
  };

  const defaultOpenBrowser = async (url: string) => {
    const request = new URL(url);
    if (request.searchParams.get("client_id") === "dynamic_agent_client") {
      assert.equal(request.searchParams.has("id_token_hint"), false);
    }
    const response = await callback(url);
    assert.equal(response.status, 200);
  };
  const newAuth = (openBrowser = options.openBrowser ?? defaultOpenBrowser) => new ChatGPTAuth({
    dataDir,
    fetch: fetcher,
    openBrowser,
    endpoints,
  });
  const raw = async () => JSON.parse(await readFile(join(dataDir, "chatgpt-auth.json"), "utf8")) as SavedState;

  return {
    auth: newAuth(),
    callback,
    counts: () => ({ refresh: refreshCount, revoke: revokeCount }),
    dataDir,
    newAuth,
    raw,
  };
}

test("loopback sign-in validates identity, persists a private profile, and signs out locally before revocation", async (t) => {
  const { auth, dataDir, counts } = await fixture(t);

  const connected = await auth.signIn();
  assert.equal(connected.state, "signed_in");
  assert.equal(connected.planEnabled, true);
  assert.equal(connected.profile?.email, "reader@example.test");
  assert.equal(connected.profiles.length, 1);

  if (process.platform !== "win32") {
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dataDir, "chatgpt-auth.json"))).mode & 0o777, 0o600);
  }
  const saved = await readFile(join(dataDir, "chatgpt-auth.json"), "utf8");
  assert.match(saved, /urn:uuid:/);
  assert.match(saved, new RegExp(clientId));
  assert.match(saved, new RegExp(subject));

  assert.deepEqual(await auth.signOut(), { revoked: true });
  assert.deepEqual(counts(), { refresh: 0, revoke: 1 });
  const signedOut = await auth.status();
  assert.equal(signedOut.state, "signed_out");
  assert.equal(signedOut.profiles.length, 1, "logout retains the issued client and profile identity");
});

test("concurrent access-token requests serialize one rotating refresh and persist its verified successor", async (t) => {
  const { auth, dataDir, counts } = await fixture(t, { initialExpiresIn: 30 });
  await auth.signIn();

  const tokens = await Promise.all([auth.accessToken(), auth.accessToken()]);
  assert.deepEqual(tokens, ["rotated-access-token", "rotated-access-token"]);
  assert.deepEqual(counts(), { refresh: 1, revoke: 0 });
  const raw = await readFile(join(dataDir, "chatgpt-auth.json"), "utf8");
  assert.match(raw, /rotated-refresh-token/);
  assert.doesNotMatch(raw, /initial-refresh-token/);
});

test("newAccount adds a second profile without replacing the first, and selectProfile changes only the active one", async (t) => {
  const { auth } = await fixture(t);
  const first = await auth.signIn();
  const firstId = first.profile?.id;
  assert.ok(firstId);

  const second = await auth.signIn({ newAccount: true });
  assert.equal(second.profiles.length, 2);
  assert.notEqual(second.profile?.id, firstId);

  const selected = await auth.selectProfile(firstId);
  assert.equal(selected.profile?.id, firstId);
  assert.equal(selected.profiles.length, 2);
});

test("a terminal refresh failure preserves the profile, reports AUTH_REQUIRED, and moves it to needs_login", async (t) => {
  const { auth } = await fixture(t, { initialExpiresIn: 30, refreshFailure: true });
  await auth.signIn();

  await assert.rejects(auth.accessToken(), expectCode("AUTH_REQUIRED"));
  const status = await auth.status();
  assert.equal(status.state, "needs_login");
  assert.equal(status.profiles.length, 1);
  assert.equal(status.planEnabled, false);
});

test("cancelSignIn closes a pending loopback attempt", async (t) => {
  const opened = deferred();
  const { auth } = await fixture(t, { openBrowser: async () => { opened.resolve(); } });

  const signingIn = auth.signIn();
  await opened.promise;
  auth.cancelSignIn();
  await assert.rejects(signingIn, expectCode("CANCELLED"));
  assert.equal((await auth.status()).state, "signed_out");
});

test("a callback with the wrong state neither consumes the listener nor changes the active profile", async (t) => {
  const setup = await fixture(t);
  const original = await setup.auth.signIn();
  const originalId = original.profile?.id;
  assert.ok(originalId);

  const reauth = setup.newAuth(async (url) => {
    assert.match(new URL(url).searchParams.get("id_token_hint") ?? "", /^[^.]+\.[^.]+\.[^.]+$/);
    const rejected = await setup.callback(url, { state: "attacker-state" });
    assert.equal(rejected.status, 400);
    const unchanged = await setup.auth.status();
    assert.equal(unchanged.state, "signed_in");
    assert.equal(unchanged.profile?.id, originalId);
    const accepted = await setup.callback(url);
    assert.equal(accepted.status, 200);
  });
  const connected = await reauth.signIn();
  assert.equal(connected.state, "signed_in");
  assert.equal(connected.profile?.id, originalId);
});

test("default protocol paths are explicit while discovery supplies JWKS and revocation", async () => {
  const discoveredIssuer = "https://auth.test.invalid";
  const endpoints = await resolveEndpoints(async () => Response.json({
    issuer: discoveredIssuer,
    authorization_endpoint: `${discoveredIssuer}/different-authorization-path`,
    token_endpoint: `${discoveredIssuer}/different-token-path`,
    jwks_uri: `${discoveredIssuer}/discovered-jwks`,
    revocation_endpoint: `${discoveredIssuer}/discovered-revoke`,
  }), { issuer: discoveredIssuer });

  assert.equal(endpoints.authorization, `${discoveredIssuer}/api/accounts/authorize`);
  assert.equal(endpoints.token, `${discoveredIssuer}/api/accounts/oauth/token`);
  assert.equal(endpoints.jwks, `${discoveredIssuer}/discovered-jwks`);
  assert.equal(endpoints.revocation, `${discoveredIssuer}/discovered-revoke`);
});

test("sign-out removes the ID-token hint from later authorization URLs", async (t) => {
  const setup = await fixture(t);
  await setup.auth.signIn();
  await setup.auth.signOut();
  const reauth = setup.newAuth(async (url) => {
    assert.equal(new URL(url).searchParams.has("id_token_hint"), false);
    const response = await setup.callback(url);
    assert.equal(response.status, 200);
  });
  assert.equal((await reauth.signIn()).state, "signed_in");
});

test("a wrong nonce or signature cannot activate a profile", async (t) => {
  for (const identityMode of ["wrong_nonce", "bad_signature"] as const) {
    await t.test(identityMode, async (child) => {
      const setup = await fixture(child, { identityMode });
      await assert.rejects(setup.auth.signIn(), expectCode("ID_TOKEN_INVALID"));
      const status = await setup.auth.status();
      assert.equal(status.state, "signed_out");
      assert.equal(status.profiles.length, 0);
      const saved = await setup.raw();
      assert.equal(saved.activeProfileId, undefined);
      assert.equal(saved.profiles.length, 0);
      assert.equal(saved.pendingRegistrations.length, 1, "issued client identity remains reusable after a failed exchange");
    });
  }
});

test("a rotated token is checkpointed across a temporary JWKS failure and completed after restart without reuse", async (t) => {
  const setup = await fixture(t, { initialExpiresIn: 30, refreshJwksFailures: 1 });
  await setup.auth.signIn();

  await assert.rejects(setup.auth.accessToken(), expectCode("AUTH_TEMPORARY"));
  const checkpoint = await setup.raw();
  assert.equal(checkpoint.profiles[0]?.credentials?.refreshToken, "initial-refresh-token");
  assert.equal(checkpoint.profiles[0]?.pendingRefresh?.credentials.refreshToken, "rotated-refresh-token");
  assert.equal(setup.counts().refresh, 1);

  const restarted = setup.newAuth();
  assert.equal(await restarted.accessToken(), "rotated-access-token");
  assert.equal(setup.counts().refresh, 1, "restart verifies the checkpoint instead of reusing the old refresh token");
  const recovered = await setup.raw();
  assert.equal(recovered.profiles[0]?.credentials?.refreshToken, "rotated-refresh-token");
  assert.equal(recovered.profiles[0]?.pendingRefresh, undefined);
  assert.doesNotMatch(JSON.stringify(recovered), /initial-refresh-token/);
});

test("caller cancellation during refresh still commits a returned rotating token", async (t) => {
  const refreshGate = gate();
  const setup = await fixture(t, { initialExpiresIn: 30, refreshGate });
  await setup.auth.signIn();
  const controller = new AbortController();
  const request = setup.auth.accessToken(controller.signal);
  await refreshGate.started.promise;
  controller.abort();
  refreshGate.release.resolve();

  await assert.rejects(request, expectCode("CANCELLED"));
  assert.equal(await setup.auth.accessToken(), "rotated-access-token");
  assert.equal(setup.counts().refresh, 1);
  const saved = await setup.raw();
  assert.equal(saved.profiles[0]?.credentials?.refreshToken, "rotated-refresh-token");
  assert.equal(saved.profiles[0]?.pendingRefresh, undefined);
});

test("cancelled sign-in ignores a valid token response that arrives later", async (t) => {
  const authorizationGate = gate();
  const setup = await fixture(t, { authorizationGate });
  const signingIn = setup.auth.signIn();
  await authorizationGate.started.promise;
  setup.auth.cancelSignIn();
  authorizationGate.release.resolve();

  await assert.rejects(signingIn, expectCode("CANCELLED"));
  const status = await setup.auth.status();
  assert.equal(status.state, "signed_out");
  assert.equal(status.profiles.length, 0);
  const saved = await setup.raw();
  assert.equal(saved.activeProfileId, undefined);
  assert.equal(saved.profiles.length, 0);
  assert.equal(saved.pendingRegistrations.length, 1);
});

test("sign-out removes local credentials before revoke and reports a failed revoke explicitly", async (t) => {
  let observedClearedState = false;
  const setup = await fixture(t, {
    revokeFailure: true,
    onRevoke: async (dataDir) => {
      const saved = JSON.parse(await readFile(join(dataDir, "chatgpt-auth.json"), "utf8")) as SavedState;
      const profile = saved.profiles[0];
      assert.equal(profile?.state, "signed_out");
      assert.equal(profile?.credentials, undefined);
      assert.equal(profile?.pendingRefresh, undefined);
      assert.deepEqual(profile?.scopes, []);
      observedClearedState = true;
    },
  });
  await setup.auth.signIn();

  assert.deepEqual(await setup.auth.signOut(), { revoked: false });
  assert.equal(observedClearedState, true);
  assert.deepEqual(setup.counts(), { refresh: 0, revoke: 1 });
  const status = await setup.auth.status();
  assert.equal(status.state, "signed_out");
  assert.equal(status.profiles.length, 1);
});

test("public auth failures use the error codes handled by the extension", async (t) => {
  await t.test("authorization denied", async (child) => {
    const setup = await fixture(child);
    const auth = setup.newAuth(async (url) => {
      const response = await setup.callback(url, { error: "access_denied" });
      assert.equal(response.status, 200);
    });
    await assert.rejects(auth.signIn(), expectCode("ACCESS_DENIED"));
    assert.equal((await auth.status()).state, "signed_out");
  });

  await t.test("sharing scope absent", async (child) => {
    const setup = await fixture(child, {
      grantedScopes: "openid profile email offline_access resource.invoke",
    });
    const status = await setup.auth.signIn();
    assert.equal(status.state, "signed_in");
    assert.equal(status.planEnabled, false);
    await assert.rejects(setup.auth.accessToken(), expectCode("PLAN_DISABLED"));
  });
});

test("valid saved credentials skip discovery and work when the auth discovery service is unavailable", async (t) => {
  const { auth, dataDir } = await fixture(t);
  await auth.signIn();
  let networkRequests = 0;
  // No endpoint overrides: this would attempt discovery before the fast path fix.
  const resumed = new ChatGPTAuth({
    dataDir,
    fetch: async () => { networkRequests++; throw new Error("Discovery is unavailable"); },
  });
  assert.deepEqual(await Promise.all([resumed.accessToken(), resumed.accessToken()]), [
    "initial-access-token", "initial-access-token",
  ]);
  assert.equal(networkRequests, 0);
});
