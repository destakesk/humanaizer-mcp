// GERÇEK TARAYICI E2E — login_browser akışı: MCP → chromium → onay → oturum.
// Frontend dev server (localhost:3001) + prod API/Supabase ile koşar.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requireFrontend = createRequire("/Users/muratbeyhan/dev/aicontent/frontend/package.json");
const { chromium } = requireFrontend("@playwright/test");

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const APP = process.env.E2E_APP_URL ?? "http://localhost:3001";

const home = mkdtempSync(join(tmpdir(), "hmcp-br-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, HOME: home, HUMANAIZER_APP_URL: APP },
});
const client = new Client({ name: "browser-e2e", version: "0.0.0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`[${name}] ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
};

// 1) login_browser — tarayıcıyı BİZ süreceğiz
const start = await call("login_browser", { open_browser: false });
console.log("AUTH-URL:", start.auth_url);

// 2) Chromium: önce login sayfasından gerçek Supabase oturumu aç
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 120)); });

await page.goto(`${APP}/login`, { waitUntil: "networkidle" });
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL(/account|hesabim/, { timeout: 30000 });
console.log("BROWSER-LOGIN ok →", page.url().replace(APP, ""));

// 3) Onay sayfasına git — consent ekranı gelmeli
await page.goto(start.auth_url, { waitUntil: "networkidle" });
await page.waitForSelector(`text=${EMAIL}`, { timeout: 20000 });
console.log("CONSENT-PAGE ok (email görünür)");

// 4) "Connect account" tıkla — iki başarı yolu var:
//    (a) fetch POST çalışır → sayfa "Connected" gösterir
//    (b) PNA/mixed-content fetch'i engellerse GET fallback → 127.0.0.1'e navigasyon
await page.click('button:has-text("Connect account")');
const outcome = await Promise.race([
  page.waitForSelector("text=Connected", { timeout: 15000 }).then(() => "post"),
  page.waitForURL(/127\.0\.0\.1/, { timeout: 15000 }).then(() => "get-fallback"),
]);
console.log("APPROVED — yol:", outcome);
await browser.close();

// 5) MCP tarafı: bağlantı gerçekleşti mi + GERÇEK token'la API çalışıyor mu
const st = await call("login_status");
console.log("LOGIN-STATUS:", st.browser_auth, JSON.stringify(st.session));
if (st.browser_auth !== "connected") throw new Error("connected değil");

const account = await call("get_account", {});
console.log("GET-ACCOUNT ok — email:", account.email, "plan:", account.subscription?.plan_id ?? account.subscription?.id ?? "?");
const kits = await call("list_brand_kits", {});
console.log("BRAND-KITS:", kits.length);

console.log("\nBROWSER-E2E OK — tarayıcıdan bağlanan oturum gerçek API çağrısı yaptı");
await client.close();
process.exit(0);
