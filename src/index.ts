#!/usr/bin/env node
/**
 * humanaizer-mcp — Humanaizer (humanaizer.io) MCP server.
 *
 * End-to-end AI content generation from Claude:
 *   login → plan/quota check → pick brand/content-type/template →
 *   create_content (autopilot pipeline) → poll status → get final HTML →
 *   publish to a connected integration (WordPress/Ghost/Strapi/...).
 *
 * Auth: Supabase email+password → JWT (auto-refresh). Session is persisted
 * to ~/.humanaizer/mcp-session.json (0600). All plan/quota enforcement is
 * server-side; this client surfaces limits and clear error messages.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config — all public values; overridable via env.
// ---------------------------------------------------------------------------

/**
 * Güvenlik: JWT taşıyan her istek TLS üzerinden gitmek zorunda. Env ile
 * override edilen URL http ise (localhost hariç) server hiç başlamaz —
 * token'ı düz metin gönderen bir yanlış yapılandırmayı sessizce kabul etmeyiz.
 */
function assertSecureUrl(name: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} geçerli bir URL değil: ${raw}`);
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1";
  if (u.protocol !== "https:" && !isLocal) {
    throw new Error(`${name} https:// olmalı (JWT düz metin gönderilemez): ${raw}`);
  }
  return raw.replace(/\/$/, "");
}

const API_URL = assertSecureUrl(
  "HUMANAIZER_API_URL",
  process.env.HUMANAIZER_API_URL ?? "https://api.humanaizer.io",
);
const SUPABASE_URL = assertSecureUrl(
  "HUMANAIZER_SUPABASE_URL",
  process.env.HUMANAIZER_SUPABASE_URL ?? "https://zmdbafqjtqlenleocukz.supabase.co",
);

/** Ağ istekleri asılı kalmasın — tek tool çağrısı en çok 60 sn bekler. */
const FETCH_TIMEOUT_MS = 60_000;

/** Tarayıcı yetkilendirme onay sayfasının yaşadığı frontend. */
const APP_URL = assertSecureUrl(
  "HUMANAIZER_APP_URL",
  process.env.HUMANAIZER_APP_URL ?? "https://humanaizer.io",
);
// Supabase anon (publishable) key — shipped in the humanaizer.io web bundle;
// not a secret. Row access is enforced server-side by RLS + the API.
const SUPABASE_ANON_KEY =
  process.env.HUMANAIZER_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InptZGJhZnFqdHFsZW5sZW9jdWt6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NzA0NDMsImV4cCI6MjA5MzA0NjQ0M30.bVUMLSwi37WlltqdZYVIkpIJUHgXnECYvSaj3C4iQtE";

const SESSION_DIR = path.join(os.homedir(), ".humanaizer");
const SESSION_FILE = path.join(SESSION_DIR, "mcp-session.json");

// ---------------------------------------------------------------------------
// Session (Supabase JWT) management
// ---------------------------------------------------------------------------
type Session = {
  access_token: string;
  refresh_token: string;
  /** Unix seconds */
  expires_at: number;
  email?: string;
};

let session: Session | null = loadSession();

function loadSession(): Session | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Session;
    if (parsed.access_token && parsed.refresh_token) return parsed;
  } catch {
    /* no session yet */
  }
  return null;
}

function saveSession(s: Session | null): void {
  session = s;
  try {
    if (s === null) {
      fs.rmSync(SESSION_FILE, { force: true });
      return;
    }
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  } catch {
    /* persistence is best-effort; in-memory session still works */
  }
}

async function supabaseAuth(body: Record<string, string>, grant: string): Promise<Session> {
  const resp = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    const msg =
      (data.error_description as string) ||
      (data.msg as string) ||
      (data.error as string) ||
      `auth failed (HTTP ${resp.status})`;
    throw new Error(msg);
  }
  const expiresIn = Number(data.expires_in ?? 3600);
  return {
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token),
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    email: (data.user as { email?: string } | undefined)?.email,
  };
}

async function refreshSession(current: Session): Promise<Session> {
  try {
    const refreshed = await supabaseAuth({ refresh_token: current.refresh_token }, "refresh_token");
    refreshed.email = refreshed.email ?? current.email;
    saveSession(refreshed);
    return refreshed;
  } catch {
    // Refresh token iptal edilmiş/geçersiz — ölü oturumu diskte BIRAKMA.
    saveSession(null);
    throw new Error(
      "Oturum süresi doldu veya iptal edildi. `login` tool'u ile tekrar giriş yap.",
    );
  }
}

async function ensureFreshToken(): Promise<Session> {
  if (!session) {
    throw new Error(
      "Oturum yok. Önce `login` tool'u ile Humanaizer hesabına giriş yap (email + password).",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at - now > 60) return session;
  return refreshSession(session);
}

// ---------------------------------------------------------------------------
// Tarayıcı yetkilendirme (login_browser) — RFC 8252 loopback modeli
// ---------------------------------------------------------------------------
// `login_browser` 127.0.0.1'de tek seferlik bir callback dinleyicisi açar ve
// tarayıcıda ${APP_URL}/account/mcp-auth?port&state onay sayfasını başlatır.
// Sayfa (kullanıcı TIKLAYINCA) Supabase oturum token'larını buraya POST'lar.
// Güvenlik: state nonce (timing-safe karşılaştırma), yalnız loopback bind,
// 5 dk sonra otomatik kapanma, allowlist'li CORS, 64KB gövde sınırı.

const BROWSER_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_BODY_LIMIT = 64 * 1024;
const ALLOWED_ORIGINS = new Set(
  [
    "https://humanaizer.io",
    "https://www.humanaizer.io",
    "http://localhost:3000",
    "http://localhost:3001",
    APP_URL,
  ].map((o) => o.replace(/\/$/, "")),
);

type PendingAuth = {
  server: http.Server;
  state: string;
  timer: NodeJS.Timeout;
  result: "pending" | "connected" | "denied" | "expired";
};

let pendingAuth: PendingAuth | null = null;

function closePendingAuth(finalResult?: PendingAuth["result"]): void {
  if (!pendingAuth) return;
  if (finalResult) pendingAuth.result = finalResult;
  clearTimeout(pendingAuth.timer);
  try {
    pendingAuth.server.close();
  } catch {
    /* already closed */
  }
}

function statesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Payload'u doğrula + oturumu kaydet. Dönüş: kullanıcıya gösterilecek sonuç. */
function consumeAuthPayload(payload: Record<string, unknown>): { status: number; body: string } {
  if (!pendingAuth || pendingAuth.result !== "pending") {
    return { status: 410, body: JSON.stringify({ error: "no pending authorization" }) };
  }
  if (typeof payload.state !== "string" || !statesMatch(payload.state, pendingAuth.state)) {
    return { status: 403, body: JSON.stringify({ error: "state mismatch" }) };
  }
  if (payload.error === "denied") {
    closePendingAuth("denied");
    return { status: 200, body: JSON.stringify({ ok: true, result: "denied" }) };
  }
  const access = payload.access_token;
  const refresh = payload.refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) {
    return { status: 400, body: JSON.stringify({ error: "missing tokens" }) };
  }
  const expiresAt = Number(payload.expires_at);
  saveSession({
    access_token: access,
    refresh_token: refresh,
    expires_at: Number.isFinite(expiresAt) && expiresAt > 0
      ? Math.floor(expiresAt)
      : Math.floor(Date.now() / 1000) + 3600,
    email: typeof payload.email === "string" && payload.email ? payload.email : undefined,
  });
  closePendingAuth("connected");
  return { status: 200, body: JSON.stringify({ ok: true, result: "connected" }) };
}

const AUTH_DONE_HTML = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;height:90vh;color:#1a1d24"><div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body>`;

function startAuthServer(): Promise<{ port: number; state: string }> {
  closePendingAuth("expired");
  const state = randomBytes(24).toString("base64url");

  const server = http.createServer((req, res) => {
    const origin = String(req.headers.origin ?? "").replace(/\/$/, "");
    const corsHeaders: Record<string, string> = ALLOWED_ORIGINS.has(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
          Vary: "Origin",
        }
      : {};
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404, corsHeaders);
      return res.end();
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      return res.end();
    }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > AUTH_BODY_LIMIT) req.destroy();
      });
      req.on("end", () => {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          /* boş bırak — consume 400 döner */
        }
        const out = consumeAuthPayload(payload);
        res.writeHead(out.status, { "Content-Type": "application/json", ...corsHeaders });
        res.end(out.body);
      });
      return;
    }
    if (req.method === "GET") {
      // Safari fallback'i — top-level navigasyonla gelen query paramları.
      const payload = Object.fromEntries(url.searchParams.entries()) as Record<string, unknown>;
      const out = consumeAuthPayload(payload);
      const okBody =
        out.status === 200 && out.body.includes("connected")
          ? AUTH_DONE_HTML("Bağlandı ✓", "Bu sekmeyi kapatıp Claude'a dönebilirsin.")
          : out.status === 200
            ? AUTH_DONE_HTML("İstek reddedildi", "Erişim verilmedi. Bu sekmeyi kapatabilirsin.")
            : AUTH_DONE_HTML("Yetkilendirme başarısız", "Bağlantıyı Claude'dan yeniden başlat.");
      res.writeHead(out.status, { "Content-Type": "text/html; charset=utf-8", ...corsHeaders });
      return res.end(okBody);
    }
    res.writeHead(405, corsHeaders);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("listen failed"));
      const timer = setTimeout(() => closePendingAuth("expired"), BROWSER_AUTH_TIMEOUT_MS);
      timer.unref();
      pendingAuth = { server, state, timer, result: "pending" };
      resolve({ port: addr.port, state });
    });
  });
}

function openInBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// API client — Bearer JWT, one 401 refresh-and-retry, readable errors
// ---------------------------------------------------------------------------
async function api<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  apiPath: string,
  body?: unknown,
  retried = false,
): Promise<T> {
  const s = await ensureFreshToken();
  const resp = await fetch(`${API_URL}${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${s.access_token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (resp.status === 401 && !retried) {
    // Token revoked/expired server-side — force refresh and retry once.
    await refreshSession(s);
    return api<T>(method, apiPath, body, true);
  }

  if (resp.status === 204) return undefined as T;
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    // Backend error envelope: {"error": {code, message, details}} or {detail: ...}
    const err = data.error as { code?: string; message?: string; details?: unknown } | undefined;
    const detail = data.detail as unknown;
    let msg =
      err?.message ||
      (typeof detail === "string" ? detail : undefined) ||
      (detail && typeof detail === "object"
        ? ((detail as Record<string, unknown>).error as { message?: string })?.message ??
          JSON.stringify(detail)
        : undefined) ||
      `HTTP ${resp.status}`;
    if (err?.code) msg = `[${err.code}] ${msg}`;
    if (resp.status === 402 || resp.status === 403) {
      msg += " — Plan/kota engeli olabilir; get_account ile limitlerini kontrol et.";
    }
    const e = new Error(msg) as Error & { status?: number; payload?: unknown };
    e.status = resp.status;
    e.payload = data;
    throw e;
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(payload: unknown): ToolResult {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(e: unknown): ToolResult {
  const err = e as Error & { payload?: unknown };
  let text = `Hata: ${err.message ?? String(e)}`;
  // Autopilot preflight failures carry a structured list — surface it fully.
  const payload = err.payload as
    | { detail?: { preflight_failures?: unknown }; error?: { details?: unknown } }
    | undefined;
  const preflight =
    (payload?.detail as { preflight_failures?: unknown } | undefined)?.preflight_failures ??
    (payload?.error?.details as { preflight_failures?: unknown } | undefined)?.preflight_failures;
  if (preflight) text += `\npreflight_failures: ${JSON.stringify(preflight, null, 2)}`;
  return { content: [{ type: "text", text }], isError: true };
}

function pick<T extends Record<string, unknown>>(obj: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "humanaizer", version: "0.1.0" });

server.registerTool(
  "login",
  {
    title: "Humanaizer hesabına giriş",
    description:
      "Humanaizer (humanaizer.io) hesabına email + şifre ile giriş yapar ve oturumu kaydeder. " +
      "Diğer tüm tool'lar bu oturumu kullanır. Girişten sonra plan/kota özeti döner. " +
      "Şifre yalnızca Supabase auth'a TLS üzerinden iletilir; diske şifre değil, " +
      "kısa ömürlü oturum token'ları yazılır (~/.humanaizer, 0600).",
    inputSchema: { email: z.string().email(), password: z.string().min(1) },
  },
  async ({ email, password }) => {
    try {
      const s = await supabaseAuth({ email, password }, "password");
      s.email = s.email ?? email;
      saveSession(s);
      const me = await api<Record<string, unknown>>("GET", "/api/saas/me");
      return ok({
        message: `Giriş başarılı: ${email}`,
        plan: (me.subscription as Record<string, unknown> | null) ?? "free",
        usage: me.usage,
        limits: me.limits,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "login_browser",
  {
    title: "Tarayıcıdan hesap bağla (önerilen)",
    description:
      "Şifre istemeden tarayıcı üzerinden hesap bağlar: humanaizer.io onay sayfası açılır, " +
      "kullanıcı tek tıkla izin verir. Çağrı hemen döner; kullanıcı tarayıcıda onayladıktan " +
      "sonra `login_status` (veya doğrudan `get_account`) ile bağlantıyı doğrula. " +
      "Bekleme 5 dakika sonra otomatik iptal olur.",
    inputSchema: {
      open_browser: z
        .boolean()
        .default(true)
        .describe("false → tarayıcı otomatik açılmaz, sadece URL döner"),
    },
  },
  async ({ open_browser }) => {
    try {
      const { port, state } = await startAuthServer();
      const authUrl = `${APP_URL}/account/mcp-auth?port=${port}&state=${state}`;
      const opened = open_browser ? openInBrowser(authUrl) : false;
      return ok({
        auth_url: authUrl,
        browser_opened: opened,
        expires_in_seconds: BROWSER_AUTH_TIMEOUT_MS / 1000,
        message:
          (opened
            ? "Tarayıcıda Humanaizer onay sayfası açıldı."
            : "Şu bağlantıyı tarayıcında aç: " + authUrl) +
          " Kullanıcı 'Hesabı bağla'ya tıkladıktan sonra `login_status` ile doğrula.",
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "login_status",
  {
    title: "Bağlantı durumu",
    description:
      "Tarayıcı yetkilendirmesinin sonucunu ve mevcut oturumu döner " +
      "(pending/connected/denied/expired + oturum var mı).",
    inputSchema: {},
  },
  async () => {
    return ok({
      browser_auth: pendingAuth?.result ?? "none",
      session: session ? { email: session.email ?? null, active: true } : { active: false },
      hint: session
        ? "Oturum hazır — get_account ile plan/kota alınabilir."
        : pendingAuth?.result === "pending"
          ? "Kullanıcının tarayıcıda onaylaması bekleniyor."
          : "Oturum yok — login_browser veya login ile giriş yap.",
    });
  },
);

server.registerTool(
  "logout",
  {
    title: "Oturumu kapat",
    description: "Kayıtlı Humanaizer oturumunu siler.",
    inputSchema: {},
  },
  async () => {
    saveSession(null);
    return ok("Oturum kapatıldı.");
  },
);

server.registerTool(
  "get_account",
  {
    title: "Hesap + plan + kota durumu",
    description:
      "Profil, aktif plan ve kota kullanımını döner (makale/kelime/humanize limitleri, kalan haklar). " +
      "İçerik üretmeden önce plan kontrolü için kullan.",
    inputSchema: {},
  },
  async () => {
    try {
      const me = await api<Record<string, unknown>>("GET", "/api/saas/me");
      return ok({
        email: session?.email,
        profile: pick((me.profile as Record<string, unknown>) ?? {}, [
          "display_name",
          "onboarding_completed",
          "created_at",
        ]),
        subscription: me.subscription,
        usage: me.usage,
        limits: me.limits,
        features: me.features,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_brand_kits",
  {
    title: "Marka kitlerini listele",
    description: "Hesaptaki marka kitlerini (brand kits) listeler. create_content için brand_kit_id buradan seçilir.",
    inputSchema: {},
  },
  async () => {
    try {
      const kits = await api<Record<string, unknown>[]>("GET", "/api/brand-kits");
      return ok(
        kits.map((k) =>
          pick(k, ["id", "name", "site_url", "industry", "target_language", "target_country", "is_default"]),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_content_types",
  {
    title: "İçerik tiplerini listele",
    description:
      "Hesaptaki içerik tiplerini (blog yazısı, hizmet sayfası vb.) listeler. " +
      "Zorunlu alanları görmek için get_content_type_schema kullan.",
    inputSchema: {},
  },
  async () => {
    try {
      const types = await api<Record<string, unknown>[]>("GET", "/api/content-types");
      return ok(
        types.map((t) =>
          pick(t, ["id", "name", "slug", "description", "target_word_count", "default_prompt_template_id"]),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_content_type_schema",
  {
    title: "İçerik tipi alan şeması",
    description:
      "Bir içerik tipinin field_values için beklediği alanların JSON şemasını döner " +
      "(hangi alanlar zorunlu, tipleri ne). create_content'ten önce çağır.",
    inputSchema: { content_type_id: z.string().uuid() },
  },
  async ({ content_type_id }) => {
    try {
      return ok(await api("GET", `/api/content-types/${content_type_id}/json-schema`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_prompt_templates",
  {
    title: "AI talimat şablonlarını listele",
    description:
      "Hesaptaki prompt şablonlarını (AI talimatları) listeler. create_content'te prompt_template_id olarak kullanılır; " +
      "verilmezse içerik tipinin varsayılanı kullanılır.",
    inputSchema: {},
  },
  async () => {
    try {
      const templates = await api<Record<string, unknown>[]>("GET", "/api/prompt-templates");
      return ok(
        templates.map((t) => ({
          ...pick(t, ["id", "name", "description", "content_type_id"]),
          variables: Array.isArray(t.variables)
            ? (t.variables as Record<string, unknown>[]).map((v) =>
                pick(v, ["slug", "label", "is_required", "field_type"]),
              )
            : [],
        })),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "create_content",
  {
    title: "İçerik oluştur (autopilot pipeline)",
    description:
      "Yeni içerik oluşturur ve (varsayılan) autopilot'u başlatır: outline → bölümler → humanize → " +
      "originalize → kalite kapıları → ready_to_publish. Pipeline dakikalar sürer; ilerleme için " +
      "get_content_status ile kontrol et. Kota/plan engelleri sunucuda uygulanır ve net hata döner. " +
      "field_values içerik tipinin şemasına uymalı (get_content_type_schema).",
    inputSchema: {
      content_type_id: z.string().uuid(),
      slug: z
        .string()
        .max(120)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "kebab-case slug bekleniyor (örn. sac-ekimi-fiyatlari)"),
      field_values: z.record(z.unknown()).describe("İçerik tipi alanları; en az title/primary_keyword gibi zorunlular"),
      target_country: z.string().regex(/^[A-Z]{2}$/).describe('Hedef ülke, örn. "TR", "US"'),
      target_language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).describe('Hedef dil, örn. "tr", "en", "pt"'),
      brand_kit_id: z.string().uuid().optional(),
      prompt_template_id: z.string().uuid().optional(),
      prompt_variables: z.record(z.unknown()).optional(),
      autopilot: z.boolean().default(true).describe("true → tam pipeline otomatik koşar"),
    },
  },
  async (args) => {
    try {
      const created = await api<Record<string, unknown>>("POST", "/api/contents", {
        content_type_id: args.content_type_id,
        slug: args.slug,
        field_values: args.field_values,
        target_country: args.target_country,
        target_language: args.target_language,
        ...(args.brand_kit_id ? { brand_kit_id: args.brand_kit_id } : {}),
        auto_advance: args.autopilot,
      });
      const contentId = String(created.id);

      if (args.prompt_template_id || args.prompt_variables) {
        await api("PATCH", `/api/contents/${contentId}`, {
          ...(args.prompt_template_id ? { prompt_template_id: args.prompt_template_id } : {}),
          ...(args.prompt_variables ? { prompt_variables: args.prompt_variables } : {}),
        });
      }

      if (!args.autopilot) {
        return ok({
          content_id: contentId,
          status: created.status,
          message: "İçerik manuel modda oluşturuldu (autopilot kapalı).",
        });
      }

      try {
        const start = await api<Record<string, unknown>>(
          "POST",
          `/api/contents/${contentId}/auto-advance/start`,
          { auto_approve_outline: true },
        );
        return ok({
          content_id: contentId,
          autopilot: start,
          message:
            "İçerik oluşturuldu ve autopilot başladı. get_content_status ile ilerlemeyi izle; " +
            "status ready_to_publish olunca get_content ile HTML'i al veya publish_content ile yayınla.",
        });
      } catch (startErr) {
        return ok({
          content_id: contentId,
          autopilot_error: (startErr as Error).message,
          message:
            "İçerik oluşturuldu ama autopilot BAŞLAYAMADI (yukarıdaki sebep). " +
            "Eksikleri giderip tekrar dene ya da humanaizer.io panelinden devam et.",
        });
      }
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_content_status",
  {
    title: "İçerik pipeline durumu",
    description:
      "İçeriğin yaşam döngüsü durumunu + autopilot ilerlemesini döner. ready_to_publish = tamamlandı; " +
      "failed/cost_paused/quality_failed durumlarında sebep de döner.",
    inputSchema: { content_id: z.string().uuid() },
  },
  async ({ content_id }) => {
    try {
      const [state, auto] = await Promise.all([
        api<Record<string, unknown>>("GET", `/api/contents/${content_id}/lifecycle/state`),
        api<Record<string, unknown>>("GET", `/api/contents/${content_id}/auto-advance`).catch(() => null),
      ]);
      return ok({
        lifecycle: state,
        autopilot: auto
          ? pick(auto, [
              "auto_advance_active",
              "auto_advance_stopped_reason",
              "current_step_label",
              "current_step",
              "total_steps",
              "blocking_reason",
            ])
          : null,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_contents",
  {
    title: "İçerikleri listele",
    description: 'Hesaptaki içerikleri listeler. status filtresi: draft, generating, ready_to_publish, failed vb.',
    inputSchema: {
      status: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(20),
    },
  },
  async ({ status, search, limit }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (search) params.set("search", search);
      params.set("limit", String(limit));
      const res = await api<Record<string, unknown>>("GET", `/api/contents?${params.toString()}`);
      const items = (res.items as Record<string, unknown>[]) ?? [];
      return ok({
        total: res.total,
        items: items.map((c) =>
          pick(c, ["id", "slug", "status", "title", "target_language", "target_country", "created_at", "published_url"]),
        ),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_content",
  {
    title: "İçeriğin son halini al",
    description:
      "İçeriğin nihai HTML gövdesini + meta bilgilerini döner (originalized → pre_humanized → full fallback). " +
      "ready_to_publish durumundaki içerikler için kullan.",
    inputSchema: { content_id: z.string().uuid() },
  },
  async ({ content_id }) => {
    try {
      const full = await api<Record<string, unknown>>("GET", `/api/contents/${content_id}/full`);
      return ok(full);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "retry_outline",
  {
    title: "Outline'ı yeniden dene",
    description:
      "draft'ta takılan içerik için outline üretimini tek dokunuşla yeniden kuyruğa alır (202). " +
      "Sonucu get_content_status ile izle.",
    inputSchema: { content_id: z.string().uuid() },
  },
  async ({ content_id }) => {
    try {
      return ok(await api("POST", `/api/contents/${content_id}/outline/retry`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_quality_score",
  {
    title: "Kalite skoru",
    description: "İçeriğin toplu kalite skorunu ve check bazında sonuçları döner.",
    inputSchema: { content_id: z.string().uuid() },
  },
  async ({ content_id }) => {
    try {
      return ok(await api("GET", `/api/contents/${content_id}/quality-checks/score`));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_integrations",
  {
    title: "Yayın entegrasyonlarını listele",
    description:
      "Bağlı yayın hedeflerini listeler (WordPress, Ghost, Strapi, Webflow, Shopify, Wix, custom API). " +
      "publish_content için integration_id buradan seçilir. status=active olmayanlar yayına kapalıdır.",
    inputSchema: {},
  },
  async () => {
    try {
      const rows = await api<Record<string, unknown>[]>("GET", "/api/integrations");
      return ok(rows.map((r) => pick(r, ["id", "kind", "display_name", "site_url", "status", "last_used_at"])));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "publish_content",
  {
    title: "İçeriği yayınla",
    description:
      "ready_to_publish durumundaki içeriği seçilen entegrasyona gönderir (asenkron publish job). " +
      "Sonucu list_publish_jobs ile izle. Pro plan (auto_publish) gerektirir.",
    inputSchema: {
      content_id: z.string().uuid(),
      integration_id: z.string().uuid(),
      post_status: z.enum(["draft", "publish"]).default("draft").describe('"publish" = anında canlı; "draft" = hedefte taslak'),
      categories: z.array(z.number().int()).optional().describe("WordPress kategori ID'leri"),
      tags: z.array(z.string()).optional(),
    },
  },
  async ({ content_id, integration_id, post_status, categories, tags }) => {
    try {
      const res = await api<Record<string, unknown>>("POST", `/api/contents/${content_id}/publish`, {
        integration_id,
        options: {
          post_status,
          ...(categories ? { categories } : {}),
          ...(tags ? { tags } : {}),
        },
      });
      return ok({ ...res, message: "Publish job kuyruğa alındı. Durum için list_publish_jobs çağır." });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_publish_jobs",
  {
    title: "Yayın işlerini listele",
    description: "Publish job'larının durumunu döner (queued/running/succeeded/failed + hedefteki kalıcı link).",
    inputSchema: { content_id: z.string().uuid().optional() },
  },
  async ({ content_id }) => {
    try {
      const qs = content_id ? `?content_id=${content_id}` : "";
      const rows = await api<Record<string, unknown>[]>("GET", `/api/publish-jobs${qs}`);
      return ok(
        rows.map((r) =>
          pick(r, ["id", "content_id", "integration_id", "status", "remote_permalink", "last_error", "finished_at"]),
        ),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // PII loglama: e-posta dahil kimlik bilgisi stderr'e yazılmaz.
  console.error(`humanaizer-mcp ready (api=${API_URL}, session=${session ? "restored" : "none"})`);
}

main().catch((err) => {
  console.error("humanaizer-mcp fatal:", err);
  process.exit(1);
});
