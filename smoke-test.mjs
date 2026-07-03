// Smoke test — MCP client ile server'ı stdio üzerinden dener.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, HOME: process.env.SMOKE_HOME ?? process.env.HOME },
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));
if (tools.tools.length < 14) throw new Error("beklenen tool sayısı yok");

// 1) Oturumsuz çağrı → net hata mesajı
const noSession = await client.callTool({ name: "get_account", arguments: {} });
console.log("NO-SESSION:", noSession.isError, noSession.content[0].text.slice(0, 80));
if (!noSession.isError || !noSession.content[0].text.includes("login")) {
  throw new Error("oturumsuz çağrı beklenen hatayı vermedi");
}

// 2) Yanlış şifre → Supabase'ten temiz hata
const badLogin = await client.callTool({
  name: "login",
  arguments: { email: "smoke-test@example.com", password: "wrong-password-123" },
});
console.log("BAD-LOGIN:", badLogin.isError, badLogin.content[0].text.slice(0, 100));
if (!badLogin.isError) throw new Error("yanlış şifre hata dönmedi");

// 3) Geçersiz argüman → şema reddi
const badArgs = await client.callTool({ name: "get_content_status", arguments: { content_id: "not-a-uuid" } }).catch((e) => ({ isError: true, content: [{ text: String(e.message ?? e) }] }));
console.log("BAD-ARGS:", badArgs.isError, String(badArgs.content?.[0]?.text ?? "").slice(0, 80));
if (!badArgs.isError) throw new Error("geçersiz uuid reddedilmedi");

console.log("SMOKE OK");
await client.close();
process.exit(0);
