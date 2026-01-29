<img alt="Modern Form Builder Built With Next.js." src="./apps/admin/public/preview/omni.png">
<h1 align="center">Omni</h1>

<p align="center">
  Personal AI Assistant for Telegram with Tools, Memory, and Orchestration Built with AI SDK.
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#model-providers"><strong>Model Providers</strong></a> ·
  <a href="#deploy-your-own"><strong>Deploy Your Own</strong></a> ·
  <a href="#customization"><strong>Customization</strong></a> ·
  <a href="#running-locally"><strong>Running locally</strong></a>
</p>
<br/>

## Features

- [GrammY](https://grammy.dev)
  - Telegram bot runtime with middleware, commands, and context helpers
  - Webhook adapter used for Cloudflare Workers deployments
- [AI SDK](https://sdk.vercel.ai/docs)
  - Unified API for generating text, structured objects, and tool calls with LLMs
  - OpenAI is a primary LLM provider for chat responses
- [Yandex Tracker API](https://yandex.ru/support/tracker/en/)
  - Issue search, status, and comments data
  - Direct HTTP integration with OAuth token auth
- [Yandex Wiki API](https://yandex.ru/support/wiki/en/api-ref/)
  - Page read/write operations
  - Direct HTTP integration with OAuth token auth
- [Jira Cloud API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
  - Issue search, sprint issues, and comments data
  - Direct HTTP integration with API token auth
- [PostHog](https://posthog.com)
  - Read-only analytics queries via the Agent Toolkit
  - Trends, insights, and event/property lookups
- [Supermemory](https://supermemory.ai)
  - Persistent, per-user memory
  - Semantic retrieval for relevant past context
- [Figma API](https://www.figma.com/developers/api)
  - Read-only file metadata, nodes, comments, and project listings
  - Personal access token auth
- [Google Docs/Sheets (public)](https://developers.google.com/docs/api)
	- Read public Docs/Sheets by shared link (no OAuth)
	- Read-only export access; no write or private file support
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
  - Serverless webhook hosting with global edge execution
  - Durable Objects for reliable update processing with retries
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
	- Stores generated images for admin chat + Telegram
	- Serves public image URLs for outbound messages

## Model Providers

This app ships with [OpenAI](https://openai.com/) as the default provider. However, with the [AI SDK](https://sdk.vercel.ai/docs), you can switch LLM providers to [Ollama](https://ollama.com), [Anthropic](https://anthropic.com), [Cohere](https://cohere.com/), and [many more](https://sdk.vercel.ai/providers/ai-sdk-providers) with just a few lines of code.

- Primary model (`gpt-5.2`): default model for production responses
- Fallback model (`gpt-4.1`): used if the primary model is unavailable

## Deploy your own

You can deploy your own version of Omni to Cloudflare Workers:

1) Login

```
npx wrangler login
```

2) Configure secrets (do not commit these)

```
npx wrangler secret put BOT_TOKEN --config worker/wrangler.toml
npx wrangler secret put TRACKER_TOKEN --config worker/wrangler.toml
npx wrangler secret put JIRA_API_TOKEN --config worker/wrangler.toml
npx wrangler secret put WIKI_TOKEN --config worker/wrangler.toml
npx wrangler secret put POSTHOG_PERSONAL_API_KEY --config worker/wrangler.toml
npx wrangler secret put FIGMA_TOKEN --config worker/wrangler.toml
npx wrangler secret put OPENAI_API_KEY --config worker/wrangler.toml
npx wrangler secret put SUPERMEMORY_API_KEY --config worker/wrangler.toml
npx wrangler secret put IMAGE_SIGNING_SECRET --config worker/wrangler.toml
```

3) Create R2 bucket (name: `omni`)

4) Deploy

```
npx wrangler deploy --config worker/wrangler.toml
```

5) Set Telegram webhook

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/telegram
```

## Customization

Global persona and tone live in [`apps/bot/config/SOUL.md`](apps/bot/config/SOUL.md). The Worker bundles this file at build time into [`apps/bot/config/soul.json`](apps/bot/config/soul.json) and injects it into every prompt. Per-channel overrides are available in the Admin "Channels" screen.

## Running locally

You will need to use the environment variables [defined in `.env.example`](apps/bot/.env.example) to run Omni.

> Note: You should not commit your `.env` file or it will expose secrets that will allow others to control access to your various OpenAI and authentication provider accounts.

```
bun install
bun dev
```

Your bot should now be running locally via `tsx`. Use `bun run dev:worker` to run the Cloudflare Worker locally instead.
