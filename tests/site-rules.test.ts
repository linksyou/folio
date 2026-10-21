import assert from "node:assert/strict";
import test from "node:test";
import { siteForUrl } from "../src/extension/site-rules.js";

test("site rules preserve exact scheme, host and port while matching all paths", () => {
  assert.deepEqual(siteForUrl("https://news.example.test/a?q=1#p"), {
    origin: "https://news.example.test", pattern: "https://news.example.test:443/*",
  });
  assert.deepEqual(siteForUrl("http://news.example.test/a"), {
    origin: "http://news.example.test", pattern: "http://news.example.test:80/*",
  });
  assert.deepEqual(siteForUrl("http://127.0.0.1:35799/a"), {
    origin: "http://127.0.0.1:35799", pattern: "http://127.0.0.1:35799/*",
  });
  assert.notDeepEqual(siteForUrl("https://example.test"), siteForUrl("https://sub.example.test"));
  assert.notDeepEqual(siteForUrl("https://example.test"), siteForUrl("http://example.test"));
});

test("unsupported schemes never receive an automatic translation rule", () => {
  for (const url of [undefined, "", "invalid", "file:///tmp/a.html", "chrome://settings", "chrome-extension://abc/options.html", "about:blank", "data:text/html,test"]) {
    assert.equal(siteForUrl(url), undefined);
  }
});
