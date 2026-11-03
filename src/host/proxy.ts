import { execFileSync } from "node:child_process";
import { BlockList, isIP } from "node:net";

export interface ProxySettings {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  /** macOS exceptions also support CIDR, wildcard hosts and <local>. */
  bypass?: (url: URL) => boolean;
}

interface ProxyEnvironment {
  http_proxy?: string;
  HTTP_PROXY?: string;
  https_proxy?: string;
  HTTPS_PROXY?: string;
  no_proxy?: string;
  NO_PROXY?: string;
}

interface ProxyResolutionOptions {
  env?: ProxyEnvironment;
  platform?: NodeJS.Platform;
  readSystemProxy?: () => string;
}

function readSystemProxy(): string {
  // A bounded startup read, before the native host starts processing commands.
  return execFileSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8", timeout: 1_000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
}

function bypassRules(patterns: string[], excludeSimple: boolean): (hostname: string) => boolean {
  const networks = new BlockList();
  const hosts: RegExp[] = [];
  let simple = excludeSimple;
  for (const pattern of patterns) {
    if (pattern === "<local>") { simple = true; continue; }
    const subnet = /^(.+)\/(\d+)$/.exec(pattern);
    if (subnet && isIP(subnet[1])) {
      try { networks.addSubnet(subnet[1], Number(subnet[2]), isIP(subnet[1]) === 6 ? "ipv6" : "ipv4"); }
      catch { /* Ignore invalid OS exception entries. */ }
      continue;
    }
    const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    hosts.push(new RegExp(`^${escaped}$`, "i"));
  }
  return (input) => {
    const hostname = input.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const family = isIP(hostname);
    return (simple && !family && !hostname.includes(".")) ||
      (family !== 0 && networks.check(hostname, family === 6 ? "ipv6" : "ipv4")) ||
      hosts.some((pattern) => pattern.test(hostname));
  };
}

/** Read existing routing preferences; never persist proxy credentials or change global state. */
export function resolveProxySettings(options: ProxyResolutionOptions = {}): ProxySettings {
  const env = options.env ?? process.env;
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY;
  const noProxy = env.no_proxy ?? env.NO_PROXY;
  // Even an explicitly empty variable overrides system preferences. Undici
  // supplies HTTP -> HTTPS fallback and NO_PROXY matching for environment config.
  if (httpProxy !== undefined || httpsProxy !== undefined) {
    return { httpProxy: httpProxy ?? "", httpsProxy: httpsProxy ?? "", noProxy: noProxy ?? "" };
  }
  const direct: ProxySettings = { httpProxy: "", httpsProxy: "", noProxy: noProxy ?? "" };
  if ((options.platform ?? process.platform) !== "darwin") return direct;
  let output: string;
  try { output = (options.readSystemProxy ?? readSystemProxy)(); }
  catch { return direct; }
  const values = new Map([...output.matchAll(/^\s*(\w+)\s+:\s+([^\r\n]+)$/gm)]
    .map((match) => [match[1], match[2].trim()]));
  const proxyUrl = (protocol: "HTTP" | "HTTPS"): string => {
    if (values.get(`${protocol}Enable`) !== "1") return "";
    const hostname = values.get(`${protocol}Proxy`);
    const port = Number(values.get(`${protocol}Port`));
    if (!hostname || !Number.isInteger(port) || port < 1 || port > 65535) return "";
    try {
      const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
      // HTTPSProxy is an HTTP CONNECT proxy for HTTPS destinations.
      const url = new URL(`http://${host}:${port}`);
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return "";
      return url.origin;
    } catch { return ""; }
  };
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/.exec(output)?.[1] ?? "";
  const patterns = [...exceptions.matchAll(/^\s*\d+\s+:\s+([^\r\n]+)$/gm)].map((match) => match[1].trim());
  const systemHttp = proxyUrl("HTTP");
  const systemHttps = proxyUrl("HTTPS");
  const matchesException = bypassRules(patterns, values.get("ExcludeSimpleHostnames") === "1");
  return {
    httpProxy: systemHttp, httpsProxy: systemHttps, noProxy: noProxy ?? "",
    // Unlike environment variables, macOS enables the two protocols separately.
    // Do not apply Undici's HTTP -> HTTPS fallback to a disabled system proxy.
    bypass: (url) => (url.protocol === "http:" && !systemHttp) ||
      (url.protocol === "https:" && !systemHttps) ||
      (noProxy === undefined && matchesException(url.hostname)),
  };
}
