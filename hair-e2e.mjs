// MCP E2E #2 — "hair transplant turkey" / en / GB + ton/hedef seçimi kapsam testi.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const isolatedHome = mkdtempSync(join(tmpdir(), "hmcp-hair-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, HOME: isolatedHome },
});
const client = new Client({ name: "hair-e2e", version: "0.0.0" });
await client.connect(transport);

const step = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`[${name}] ${text.slice(0, 500)}`);
  console.log(`✓ ${name}`);
  try { return JSON.parse(text); } catch { return text; }
};

await step("login", { email: EMAIL, password: PASSWORD });
const account = await step("get_account", {});
console.log("  kota:", JSON.stringify(account.usage?.articles_count), "/", JSON.stringify(account.limits?.articles_per_month));

const kits = await step("list_brand_kits", {});
const brandKit = kits[0];
const types = await step("list_content_types", {});
const ct = types.find((t) => /blog/i.test(String(t.name))) ?? types[0];

// SEÇİLEBİLİRLİK RAPORU 1 — içerik tipi şeması (zorunlu + tüm alanlar)
const schema = await step("get_content_type_schema", { content_type_id: ct.id });
const props = schema.properties ?? schema?.schema?.properties ?? {};
console.log("SCHEMA-REQUIRED:", JSON.stringify(schema.required ?? schema?.schema?.required ?? []));
console.log("SCHEMA-FIELDS:", JSON.stringify(Object.keys(props)));

// SEÇİLEBİLİRLİK RAPORU 2 — şablon değişkenleri (ton vb. burada yaşar)
const templates = await step("list_prompt_templates", {});
const tpl = templates.find((t) => t.content_type_id === ct.id) ?? templates[0];
console.log("TEMPLATE:", tpl.name);
console.log("TEMPLATE-VARS:", JSON.stringify(tpl.variables));

// Değişkenleri senaryoya göre doldur — ton dahil.
const varValues = {
  title: "Hair Transplant in Turkey: Costs, Clinics and What to Expect",
  primary_keyword: "hair transplant turkey",
  audience: "international patients from the UK researching a hair transplant abroad",
  tone: "expert, reassuring and conversational",
};
const promptVariables = {};
const missingRequired = [];
for (const v of tpl.variables ?? []) {
  if (varValues[v.slug] !== undefined) promptVariables[v.slug] = varValues[v.slug];
  else if (v.is_required) missingRequired.push(v.slug);
}
console.log("VARS-SENT:", JSON.stringify(promptVariables));
if (missingRequired.length) console.log("VARS-MISSING-REQUIRED:", JSON.stringify(missingRequired));

const fieldValues = {};
for (const key of Object.keys(props)) {
  if (varValues[key] !== undefined) fieldValues[key] = varValues[key];
}
if (!Object.keys(fieldValues).length) Object.assign(fieldValues, {
  title: varValues.title, primary_keyword: varValues.primary_keyword, audience: varValues.audience,
});

const created = await step("create_content", {
  content_type_id: ct.id,
  brand_kit_id: brandKit.id,
  prompt_template_id: tpl.id,
  slug: `hair-transplant-turkey-${Date.now() % 100000}`,
  field_values: fieldValues,
  target_country: "GB",
  target_language: "en",
  prompt_variables: promptVariables,
  autopilot: true,
});
if (created.autopilot_error) throw new Error("autopilot: " + created.autopilot_error);
const contentId = created.content_id;
console.log("CONTENT:", contentId, "(en/GB, autopilot ok)");

const started = Date.now();
let finalStatus = null;
while (Date.now() - started < 25 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 30_000));
  const st = await step("get_content_status", { content_id: contentId });
  const status = st.lifecycle?.status ?? "?";
  console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${status} ${st.autopilot?.current_step_label ?? ""}`);
  if (["ready_to_publish", "failed", "cost_paused", "early_quality_failed", "final_quality_failed"].includes(status)) {
    finalStatus = status;
    break;
  }
}
if (finalStatus !== "ready_to_publish") throw new Error(`pipeline sonu: ${finalStatus}`);

const full = await step("get_content", { content_id: contentId });
const html = String(full.originalized_html ?? full.pre_humanized_html ?? full.full_content_html ?? full.html ?? "");
const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const words = plain.split(" ").filter(Boolean);

// DİL DOĞRULAMA — İngilizce stopword oranı vs Türkçe karakter sızıntısı
const enStop = new Set(["the","and","of","to","a","in","is","for","with","that","you","your","are","it","on","as","or"]);
const enRatio = words.filter((w) => enStop.has(w.toLowerCase())).length / words.length;
const trChars = (plain.match(/[ğüşıöçĞÜŞİÖÇ]/g) ?? []).length;
console.log("LANG-CHECK: en-stopword-ratio=", enRatio.toFixed(3), "tr-char-count=", trChars, "words=", words.length);
console.log("SAMPLE:", plain.slice(0, 400));

const quality = await step("get_quality_score", { content_id: contentId });
console.log("QUALITY:", JSON.stringify(quality));

console.log("\nHAIR-E2E OK —", contentId);
await client.close();
process.exit(0);
