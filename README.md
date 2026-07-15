# humanaizer-mcp

MCP server for [Humanaizer](https://humanaizer.io) — end-to-end AI content generation from Claude (Claude Code, Claude Desktop or any MCP client).

Login with your Humanaizer account, check your plan & quotas, then create content that runs the full pipeline automatically (outline → sections → humanize → originalize → quality gates → ready to publish) and push it to your connected CMS (WordPress, Ghost, Strapi, Webflow, Shopify, Wix or a custom API).

## Setup

### Claude Code

```bash
claude mcp add humanaizer -- npx -y humanaizer-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "humanaizer": {
      "command": "npx",
      "args": ["-y", "humanaizer-mcp"]
    }
  }
}
```

### Claude Code skill (recommended)

The package ships a skill that teaches Claude the full workflow (login → plan check → create → monitor → publish), the error dictionary and safety rules (e.g. always confirm before `post_status: "publish"`). Install it once:

```bash
# personal (all projects)
mkdir -p ~/.claude/skills/humanaizer
cp "$(npm root -g)/humanaizer-mcp/skill/humanaizer/SKILL.md" ~/.claude/skills/humanaizer/ 2>/dev/null \
  || curl -fsSL https://unpkg.com/humanaizer-mcp/skill/humanaizer/SKILL.md \
     -o ~/.claude/skills/humanaizer/SKILL.md
```

(Or copy `skill/humanaizer/SKILL.md` from this package into your project's `.claude/skills/humanaizer/`.)

## Usage

1. **Connect once** — ask Claude: *"Humanaizer hesabımı bağla"*. The `login_browser` tool opens a consent page on humanaizer.io in your browser; approve with one click (no password ever enters the chat). Password login (`login`) remains available as a fallback for headless environments. The session is stored at `~/.humanaizer/mcp-session.json` (0600) and auto-refreshes.
2. **Check your plan** — `get_account` shows subscription, usage and limits. All quota enforcement happens server-side.
3. **Create content** — Claude picks a brand kit, content type and template, fills the required fields and calls `create_content`. Autopilot runs the whole pipeline; progress is polled with `get_content_status`.
4. **Publish** — when the content reaches `ready_to_publish`, `publish_content` sends it to a connected integration; `list_publish_jobs` returns the live permalink.

## Tools

| Tool | Purpose |
| --- | --- |
| `login_browser` / `login_status` | Browser-based account connect (one-click consent on humanaizer.io, RFC 8252 loopback; state nonce, 5-min window) |
| `login` / `logout` | Email+password fallback (Supabase JWT, auto-refresh) |
| `get_account` | Plan, usage, limits, features |
| `list_brand_kits` | Brand kits |
| `list_content_types` / `get_content_type_schema` | Content types + required `field_values` schema |
| `list_prompt_templates` | AI instruction templates + variables |
| `create_content` | Create + start autopilot pipeline |
| `get_content_status` | Lifecycle state + autopilot progress |
| `list_contents` / `get_content` | Browse contents / fetch final HTML |
| `retry_outline` | One-tap retry for stuck drafts |
| `get_quality_score` | Aggregated quality score |
| `list_integrations` | Connected publish targets |
| `publish_content` / `list_publish_jobs` | Publish + track jobs |

## Environment overrides

| Variable | Default |
| --- | --- |
| `HUMANAIZER_API_URL` | `https://api.humanaizer.io` |
| `HUMANAIZER_SUPABASE_URL` | production project |
| `HUMANAIZER_SUPABASE_ANON_KEY` | production publishable key |
| `HUMANAIZER_APP_URL` | `https://humanaizer.io` (browser consent page) |

## Requirements

- Node.js ≥ 18
- A [humanaizer.io](https://humanaizer.io) account (free plan works; publishing requires a plan with `auto_publish`)

## Links

- [humanaizer.io](https://humanaizer.io) — AI content generation & humanizer platform
- [Free AI Humanizer](https://humanaizer.io/tools/ai-humanizer) — make AI text read naturally (no sign-up to try)
- [Pricing & plans](https://humanaizer.io/pricing)
- [Blog](https://humanaizer.io/blog) — guides on writing natural, high-quality AI content

## License

MIT
