import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProxySettings } from "../src/host/proxy.js";

const systemSettings = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 127.0.0.1
  HTTPPort : 7890
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7891
  ExceptionsList : <array> {
    0 : localhost
    1 : *.local
    2 : 192.168.0.0/16
    3 : fd00::/8
    4 : <local>
  }
}`;

test("GUI-launched hosts read static macOS HTTP and HTTPS proxies", () => {
  const proxy = resolveProxySettings({ env: {}, platform: "darwin", readSystemProxy: () => systemSettings });
  assert.equal(proxy.httpProxy, "http://127.0.0.1:7890");
  assert.equal(proxy.httpsProxy, "http://127.0.0.1:7891");
  assert.equal(proxy.bypass?.(new URL("https://api.openai.com")), false);
  for (const host of ["localhost", "printer.local", "192.168.1.10", "[fd00::1]", "intranet"]) {
    assert.equal(proxy.bypass?.(new URL(`http://${host}`)), true, host);
  }
  for (const host of ["localhost.example.com", "printer.local.example.com", "192.169.1.10", "[fe80::1]"]) {
    assert.equal(proxy.bypass?.(new URL(`http://${host}`)), false, host);
  }
});

test("environment proxy settings take precedence, including lowercase empty values", () => {
  let reads = 0;
  const readSystemProxy = () => { reads++; return systemSettings; };
  assert.deepEqual(resolveProxySettings({
    env: { http_proxy: "", HTTP_PROXY: "http://ignored.invalid", HTTPS_PROXY: "http://chosen.invalid", NO_PROXY: "localhost" },
    platform: "darwin", readSystemProxy,
  }), { httpProxy: "", httpsProxy: "http://chosen.invalid", noProxy: "localhost" });
  assert.equal(reads, 0);
});

test("NO_PROXY overrides macOS bypass exceptions without disabling its proxies", () => {
  const proxy = resolveProxySettings({
    env: { no_proxy: "", NO_PROXY: "*" }, platform: "darwin", readSystemProxy: () => systemSettings,
  });
  assert.equal(proxy.noProxy, "");
  assert.equal(proxy.bypass?.(new URL("http://localhost")), false);
  assert.equal(proxy.httpProxy, "http://127.0.0.1:7890");
});

test("a disabled system HTTPS proxy does not inherit the HTTP proxy", () => {
  const proxy = resolveProxySettings({
    env: {}, platform: "darwin", readSystemProxy: () => systemSettings.replace("HTTPSEnable : 1", "HTTPSEnable : 0"),
  });
  assert.equal(proxy.httpsProxy, "");
  assert.equal(proxy.bypass?.(new URL("https://api.openai.com")), true);
  assert.equal(proxy.bypass?.(new URL("http://example.com")), false);
});

test("non-macOS and unavailable system preferences leave unconfigured traffic direct", () => {
  assert.deepEqual(resolveProxySettings({
    env: {}, platform: "linux", readSystemProxy: () => { throw new Error("must not run"); },
  }), { httpProxy: "", httpsProxy: "", noProxy: "" });
  assert.deepEqual(resolveProxySettings({
    env: {}, platform: "darwin", readSystemProxy: () => { throw new Error("scutil unavailable"); },
  }), { httpProxy: "", httpsProxy: "", noProxy: "" });
});

test("system proxy addresses cannot introduce credentials or URL paths", () => {
  for (const host of ["user:password@proxy.invalid", "proxy.invalid/path", "proxy.invalid?query"]) {
    const proxy = resolveProxySettings({
      env: {}, platform: "darwin", readSystemProxy: () => systemSettings.replaceAll("127.0.0.1", host),
    });
    assert.equal(proxy.httpProxy, "");
    assert.equal(proxy.httpsProxy, "");
  }
});
