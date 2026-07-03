// login_browser callback sunucusu güvenlik testi — tarayıcısız, HTTP ile.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hmcp-auth-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, HOME: home },
});
const client = new Client({ name: "auth-test", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  try { return { isError: !!res.isError, data: JSON.parse(text) }; } catch { return { isError: !!res.isError, data: text }; }
};

// 1) login_browser (tarayıcı açmadan) → auth_url + port + state
const start = await call("login_browser", { open_browser: false });
if (start.isError) throw new Error("login_browser: " + JSON.stringify(start.data));
const u = new URL(start.data.auth_url);
const port = u.searchParams.get("port");
const state = u.searchParams.get("state");
console.log("AUTH-URL ok — host:", u.host, "port:", port, "state-len:", state.length);
if (!u.href.startsWith("https://humanaizer.io/account/mcp-auth")) throw new Error("beklenmeyen auth_url");

const cb = `http://127.0.0.1:${port}/callback`;

// 2) pending durumu
let st = await call("login_status");
console.log("STATUS-1:", st.data.browser_auth, st.data.session.active);
if (st.data.browser_auth !== "pending") throw new Error("pending bekleniyordu");

// 3) yanlış state → 403, oturum YOK
let r = await fetch(cb, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ state: "x".repeat(32), access_token: "evil", refresh_token: "evil" }) });
console.log("WRONG-STATE:", r.status);
if (r.status !== 403) throw new Error("403 bekleniyordu");
st = await call("login_status");
if (st.data.session.active) throw new Error("yanlış state oturum yaratmamalı!");

// 4) token eksik → 400
r = await fetch(cb, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ state }) });
console.log("MISSING-TOKENS:", r.status);
if (r.status !== 400) throw new Error("400 bekleniyordu");

// 5) CORS preflight — allowlist origin
r = await fetch(cb, { method: "OPTIONS", headers: { origin: "https://humanaizer.io" } });
console.log("PREFLIGHT:", r.status, "ACAO:", r.headers.get("access-control-allow-origin"));
if (r.headers.get("access-control-allow-origin") !== "https://humanaizer.io") throw new Error("CORS allowlist bozuk");
r = await fetch(cb, { method: "OPTIONS", headers: { origin: "https://evil.example.com" } });
if (r.headers.get("access-control-allow-origin")) throw new Error("evil origin'e CORS verildi!");
console.log("PREFLIGHT-EVIL: ACAO yok ✓");

// 6) doğru state + sahte-ama-şekilli tokenlar → 200 connected, oturum kaydedilir
r = await fetch(cb, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ state, access_token: "at-test", refresh_token: "rt-test", expires_at: Math.floor(Date.now()/1000)+3600, email: "browser@test.dev" }) });
console.log("CONNECT:", r.status, await r.text());
st = await call("login_status");
console.log("STATUS-2:", st.data.browser_auth, JSON.stringify(st.data.session));
if (st.data.browser_auth !== "connected" || !st.data.session.active) throw new Error("connected bekleniyordu");

// 7) tek kullanımlık — listener kapandı, ikinci POST bağlanamamalı
let closed = false;
try { await fetch(cb, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000) }); }
catch { closed = true; }
console.log("SINGLE-USE: listener kapalı =", closed);
if (!closed) throw new Error("listener hala açık!");

// 8) deny akışı — yeni koşuda reddet
const start2 = await call("login_browser", { open_browser: false });
const u2 = new URL(start2.data.auth_url);
const cb2 = `http://127.0.0.1:${u2.searchParams.get("port")}/callback`;
r = await fetch(cb2, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ state: u2.searchParams.get("state"), error: "denied" }) });
console.log("DENY:", r.status, await r.text());
st = await call("login_status");
console.log("STATUS-3:", st.data.browser_auth);
if (st.data.browser_auth !== "denied") throw new Error("denied bekleniyordu");

console.log("\nBROWSER-AUTH TESTS OK");
await client.close();
process.exit(0);
