import assert from "node:assert/strict";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ChatGPTAuth } from "../src/host/auth/index.js";
import { AuthStore } from "../src/host/auth/store.js";
import { SettingsStore } from "../src/host/settings.js";

const settingsInput = {
  provider: "custom" as const,
  chatgptModel: "",
  customBaseUrl: "https://custom.test/v1",
  customModel: "test-model",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function directoryFor(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "translator-storage-locks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function assertLocksReleased(directory: string): Promise<void> {
  for (const filename of [".chatgpt-auth.lock", ".settings.lock"]) {
    await assert.rejects(lstat(join(directory, filename)), { code: "ENOENT" });
  }
}

test("saving settings while auth is locked leaves both locks reusable", async (t) => {
  const directory = await directoryFor(t);
  const authStore = new AuthStore(directory);
  const settings = new SettingsStore(directory);
  const acquired = deferred();
  const release = deferred();
  const authOperation = authStore.withLock(async (state) => {
    await authStore.writeLocked(state);
    acquired.resolve();
    await release.promise;
  });
  await acquired.promise;
  try {
    await settings.save(settingsInput);
  } finally {
    release.resolve();
    await authOperation;
  }
  await assertLocksReleased(directory);
  // A second instance must acquire the same auth lock without a stale-lock wait.
  await new AuthStore(directory).withLock(async () => {}, AbortSignal.timeout(500));
  await settings.save({ ...settingsInput, customModel: "changed-model" });
  await assertLocksReleased(directory);
});

test("auth work during an active settings save does not invalidate the settings release", async (t) => {
  const directory = await directoryFor(t);
  const acquired = deferred();
  const release = deferred();
  class WaitingSettings extends SettingsStore {
    override async read() {
      acquired.resolve();
      await release.promise;
      return super.read();
    }
  }
  const settings = new WaitingSettings(directory);
  const saving = settings.save(settingsInput);
  await acquired.promise;
  try {
    const authStore = new AuthStore(directory);
    await authStore.withLock(async (state) => authStore.writeLocked(state), AbortSignal.timeout(500));
  } finally {
    release.resolve();
    await saving;
  }
  await assertLocksReleased(directory);
  await new SettingsStore(directory).save(settingsInput);
  await assertLocksReleased(directory);
});

test("two auth instances still serialize refresh-token rotation on the same auth file", async (t) => {
  const directory = await directoryFor(t);
  const store = new AuthStore(directory);
  await store.withLock(async (state) => {
    state.activeProfileId = "synthetic-profile";
    state.profiles = [{
      id: "synthetic-profile",
      label: "Synthetic test account",
      clientId: "synthetic-client",
      subject: "synthetic-subject",
      state: "signed_in",
      scopes: ["chatgpt.tokens.use.direct"],
      credentials: {
        accessToken: "synthetic-old-access",
        refreshToken: "synthetic-old-refresh",
        expiresAt: Date.now() - 1_000,
      },
      savedAt: new Date().toISOString(),
    }];
    await store.writeLocked(state);
  });
  const refreshing = deferred();
  const release = deferred();
  let refreshCalls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    refreshCalls++;
    assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "synthetic-old-refresh");
    refreshing.resolve();
    await release.promise;
    return Response.json({
      token_type: "Bearer",
      access_token: "synthetic-new-access",
      refresh_token: "synthetic-new-refresh",
      expires_in: 3_600,
    });
  };
  const options = {
    dataDir: directory,
    fetch: fetcher,
    endpoints: {
      issuer: "https://auth.test",
      authorization: "https://auth.test/authorize",
      token: "https://auth.test/token",
      jwks: "https://auth.test/jwks",
    },
  };
  const first = new ChatGPTAuth(options).accessToken();
  await refreshing.promise;
  const second = new ChatGPTAuth(options).accessToken();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(refreshCalls, 1);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["synthetic-new-access", "synthetic-new-access"]);
  assert.equal(refreshCalls, 1, "the second instance must reuse the newly saved credential");
  await store.withLock(async (state) => {
    assert.equal(state.profiles[0].credentials?.refreshToken, "synthetic-new-refresh");
  });
  await assertLocksReleased(directory);
});
