<a>
  <h1 align="center">Omni</h1>
</a>

<p align="center">
  Telegram Bot for Yandex Tracker Built With AI SDK.
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#model-providers"><strong>Model Providers</strong></a> ·
  <a href="#deploy-your-own"><strong>Deploy Your Own</strong></a> ·
  <a href="#running-locally"><strong>Running locally</strong></a>
</p>
<br/>

- Yandex Tracker search, issue lookup, and comments context
- Natural-language answers in Russian with model fallback
- Supermemory-backed long-term history per user
- Runtime skills for shortcut commands
- Telegram allowlist for safe access
- Optional OpenAI web search tool for up-to-date answers

## Features

- [GrammY](https://grammy.dev)
  - Telegram bot runtime with middleware, commands, and context helpers
  - Webhook adapter used for Cloudflare Workers deployments
- [AI SDK](https://sdk.vercel.ai/docs)
  - Unified API for generating text, structured objects, and tool calls with LLMs
  - Hooks for building dynamic chat and generative user interfaces
- [OpenAI](https://openai.com)
  - Primary LLM provider for responses
  - Supports model switching via `OPENAI_MODEL`
- [Yandex Tracker API](https://yandex.ru/support/tracker/en/)
  - Issue search, status, and comments data
  - Direct HTTP integration with OAuth token auth
- [Supermemory](https://supermemory.ai)
  - Persistent, per-user memory
  - Semantic retrieval for relevant past context
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
  - Serverless webhook hosting with global edge execution
  - Fast deploys and built-in request logging
  - Durable Objects for reliable update processing with retries

## Model Providers

This app ships with [Openai](https://openai.com/) provider as the default. However, with the [AI SDK](https://sdk.vercel.ai/docs), you can switch LLM providers to [Ollama](https://ollama.com), [Anthropic](https://anthropic.com), [Cohere](https://cohere.com/), and [many more](https://sdk.vercel.ai/providers/ai-sdk-providers) with just a few lines of code.

- Primary model (`gpt-5.2`): default model for production responses
- Fallback model (`gpt-4.1`): used if the primary model is unavailable

## Deploy your own

You can deploy your own version of the Omni to Cloudflare Workers:

1) Login

```
npx wrangler login
```

2) Configure secrets (do not commit these)

```
npx wrangler secret put BOT_TOKEN --config worker/wrangler.toml
npx wrangler secret put TRACKER_TOKEN --config worker/wrangler.toml
npx wrangler secret put OPENAI_API_KEY --config worker/wrangler.toml
npx wrangler secret put SUPERMEMORY_API_KEY --config worker/wrangler.toml
```

3) Configure vars

```
ALLOWED_TG_IDS = 
ALLOWED_TG_GROUPS = ""
TELEGRAM_GROUP_REQUIRE_MENTION = "1"
TRACKER_CLOUD_ORG_ID = 
OPENAI_MODEL = "openai/gpt-5.2"
SUPERMEMORY_API_KEY =
WEB_SEARCH_ENABLED = "0"
WEB_SEARCH_CONTEXT_SIZE = "low"
SERVICE_NAME =
RELEASE_VERSION =
COMMIT_HASH =
REGION =
INSTANCE_ID =
```

These live in `worker/wrangler.toml` under `[vars]`, or can be set in the
Cloudflare dashboard.

4) Durable Object migration (required for Telegram updates)

```
npx wrangler deploy --config worker/wrangler.toml
```

This first deploy creates the SQLite-backed Durable Object class for free plans.

5) Deploy (subsequent updates)

```
npx wrangler deploy --config worker/wrangler.toml
```

6) Set Telegram webhook

```
https://api.telegram.org/bot<YOUR_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/telegram
```

## Running locally

You will need to use the environment variables [defined in `.env.example`](.env.example) to run OpenChat.

> Note: You should not commit your `.env` file or it will expose secrets that will allow others to control access to your various OpenAI and authentication provider accounts.

```
bun install
bun dev
```

Your bot should now be running via Cloudflare Workers.
