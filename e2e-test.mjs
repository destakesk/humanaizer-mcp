// MCP-sürücülü E2E — tüm akış humanaizer-mcp tool'ları üzerinden koşar.
// Kullanım: E2E_EMAIL=... E2E_PASSWORD=... node e2e-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error("E2E_EMAIL / E2E_PASSWORD gerekli");

// Kullanıcının gerçek ~/.humanaizer oturumunu ezme — izole HOME.
const isolatedHome = mkdtempSync(join(tmpdir(), "hmcp-e2e-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, HOME: isolatedHome },
});
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(transport);

const step = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`[${name}] ${text.slice(0, 400)}`);
  console.log(`✓ ${name}`);
  try { return JSON.parse(text); } catch { return text; }
};

// 1) login + plan
const loginRes = await step("login", { email: EMAIL, password: PASSWORD });
console.log("  plan:", JSON.stringify(loginRes.plan)?.slice(0, 120));

const account = await step("get_account", {});
console.log("  articles:", JSON.stringify(account.usage?.articles_count), "/", JSON.stringify(account.limits?.articles_per_month));

// 2) kataloglar
const kits = await step("list_brand_kits", {});
const brandKit = kits[0];
console.log("  brand:", brandKit?.name);

const types = await step("list_content_types", {});
const ct = types.find((t) => /blog/i.test(String(t.name))) ?? types[0];
console.log("  content_type:", ct?.name);

const schema = await step("get_content_type_schema", { content_type_id: ct.id });
console.log("  schema required:", JSON.stringify(schema.required ?? schema?.schema?.required ?? []).slice(0, 200));

const templates = await step("list_prompt_templates", {});
const tpl = templates.find((t) => t.content_type_id === ct.id) ?? templates[0];
console.log("  template:", tpl?.name);

// 3) içerik oluştur (autopilot)
const slug = `mcp-e2e-${Date.now()}`;
const created = await step("create_content", {
  content_type_id: ct.id,
  brand_kit_id: brandKit.id,
  prompt_template_id: tpl.id,
  slug,
  field_values: {
    title: "Saç ekimi sonrası ilk hafta bakım rehberi",
    primary_keyword: "saç ekimi sonrası bakım",
    audience: "saç ekimi olmayı planlayanlar",
  },
  target_country: "TR",
  target_language: "tr",
  autopilot: true,
});
console.log("  content_id:", created.content_id, created.autopilot_error ? `AUTOPILOT-ERR: ${created.autopilot_error}` : "(autopilot ok)");
if (created.autopilot_error) throw new Error("autopilot başlayamadı: " + created.autopilot_error);
const contentId = created.content_id;

// 4) durum takibi — 30 sn arayla, en çok 25 dk
const started = Date.now();
let finalStatus = null;
while (Date.now() - started < 25 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 30_000));
  const st = await step("get_content_status", { content_id: contentId });
  const status = st.lifecycle?.status ?? st.lifecycle?.current_status ?? JSON.stringify(st.lifecycle).slice(0, 60);
  const label = st.autopilot?.current_step_label ?? "";
  console.log(`  [${Math.round((Date.now() - started) / 1000)}s] status=${status} ${label}`);
  if (["ready_to_publish", "failed", "cost_paused", "early_quality_failed", "final_quality_failed"].includes(status)) {
    finalStatus = status;
    break;
  }
}
if (finalStatus !== "ready_to_publish") throw new Error(`pipeline bitmedi/başarısız: ${finalStatus}`);

// 5) sonuç
const full = await step("get_content", { content_id: contentId });
const html = String(full.full_content_html ?? full.originalized_html ?? full.html ?? "");
const wordish = html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
console.log("  final html:", html.length, "chars ≈", wordish, "words");

const quality = await step("get_quality_score", { content_id: contentId });
console.log("  quality:", JSON.stringify(quality).slice(0, 200));

const integrations = await step("list_integrations", {});
console.log("  integrations:", integrations.length, "(taze hesapta 0 beklenir)");

const listed = await step("list_contents", { status: "ready_to_publish", limit: 5 });
console.log("  ready list contains:", listed.items?.some((i) => i.id === contentId));

console.log("\nE2E OK — content", contentId, "ready_to_publish");
await client.close();
process.exit(0);
