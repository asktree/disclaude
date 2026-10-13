import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { ProxyAgent } from "undici";

// Discord's Cloudflare sometimes bans the IP of a Railway region (error 1015) for hours.
// Then the bot sends its Discord traffic (REST and gateway) through DISCORD_PROXY, a CONNECT
// proxy in another region (asktree/iggymanager projects/home-ai/discord-proxy).
// The bot connects directly first. It switches to the proxy only after a ban, and the next
// start connects directly again.

const GATEWAY_HOST = /(^|\.)discord\.gg$/i;

interface ParsedProxy {
  host: string;
  port: number;
  auth: string | null; // "Basic ..." for Proxy-Authorization
  uri: string; // the proxy URL without credentials
}

let active: ParsedProxy | null = null;

export function parseProxy(proxy: string): ParsedProxy {
  const url = new URL(proxy);
  const auth =
    url.username || url.password
      ? "Basic " +
        Buffer.from(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
        ).toString("base64")
      : null;
  return {
    host: url.hostname,
    port: Number(url.port) || 80,
    auth,
    uri: `${url.protocol}//${url.host}`,
  };
}

/**
 * True when a Discord response is a Cloudflare IP ban (error 1015), not a normal Discord rate limit.
 * Discord's own 429s are JSON. A Cloudflare ban is HTML or plain text ("error code: 1015").
 */
export function isIpBan(status: number, contentType: string | null, body?: string): boolean {
  if (status !== 429) return false;
  if (body && /error code: 1015|cloudflare/i.test(body)) return true;
  return !(contentType ?? "").toLowerCase().includes("application/json");
}

/** Ask Discord's public gateway endpoint (no token) whether this IP is banned. */
export async function checkIpBan(): Promise<boolean> {
  try {
    const res = await fetch("https://discord.com/api/v10/gateway");
    if (res.status !== 429) return false;
    const body = await res.text();
    return isIpBan(res.status, res.headers.get("content-type"), body);
  } catch {
    return false;
  }
}

function connectOnce(p: ParsedProxy): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(p.port, p.host);
    socket.setTimeout(10_000, () => socket.destroy(new Error("proxy connect timeout")));
    socket.once("connect", () => {
      socket.end();
      resolve();
    });
    socket.once("error", reject);
  });
}

/** Open TCP connections until the proxy answers. A sleeping Railway service wakes on the first one. */
async function wakeProxy(p: ParsedProxy, tries = 6, waitMs = 5_000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await connectOnce(p);
      return;
    } catch (error) {
      if (i >= tries) throw error;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** Open a TLS socket to host:port through the proxy (HTTP CONNECT). */
function tunnel(p: ParsedProxy, host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `${host}:${port}` };
    if (p.auth) headers["Proxy-Authorization"] = p.auth;
    const req = http.request({
      host: p.host,
      port: p.port,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout: 30_000,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      resolve(tls.connect({ socket, servername: host, ALPNProtocols: ["http/1.1"] }));
    });
    req.once("timeout", () => req.destroy(new Error("proxy CONNECT timeout")));
    req.once("error", reject);
    req.end();
  });
}

// The gateway uses the `ws` package, which calls https.request for each connection.
// While the proxy is active, gateway connections (discord.gg) go through a CONNECT tunnel.
const originalHttpsRequest = https.request;
(https as { request: typeof https.request }).request = function (this: unknown, ...args: any[]) {
  const options = args[0];
  if (
    active &&
    options &&
    typeof options === "object" &&
    !(options instanceof URL) &&
    typeof options.host === "string" &&
    GATEWAY_HOST.test(options.host)
  ) {
    const p = active;
    const host = options.host as string;
    const port = Number(options.port) || 443;
    args[0] = {
      ...options,
      agent: undefined,
      createConnection: (_opts: unknown, cb: (err: Error | null, socket?: net.Socket) => void) => {
        tunnel(p, host, port).then(
          (socket) => cb(null, socket),
          (err) => cb(err),
        );
        return undefined;
      },
    };
  }
  return (originalHttpsRequest as (...a: any[]) => http.ClientRequest).apply(this, args);
} as typeof https.request;

/** Wake the proxy and send Discord traffic through it. Returns the agent for REST clients. */
export async function enableProxy(proxy: string): Promise<ProxyAgent> {
  const p = parseProxy(proxy);
  await wakeProxy(p);
  active = p;
  return new ProxyAgent({ uri: p.uri, token: p.auth ?? undefined });
}

export function proxyActive(): boolean {
  return active !== null;
}
