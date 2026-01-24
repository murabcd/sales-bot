---
summary: "Plugin registry for Omni"
read_when:
  - Adding integrations without changing core code
---
# Plugins

Omni can load local plugins that register tools and tool hooks.

## Configuration

Environment variables:

- `PLUGINS_PATHS` — comma‑separated list of plugin entry file paths.
- `PLUGINS_ALLOWLIST` — optional allowlist of plugin ids.
- `PLUGINS_DENYLIST` — optional denylist of plugin ids (deny wins).

## Plugin format

A plugin is a module with a default export function:

```
export default function (api) {
  api.registerTool({
    name: "example_tool",
    description: "Example tool",
    tool: {
      description: "Example tool",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => `ok:${text}`,
    },
  });

  api.registerHooks({
    beforeToolCall: ({ toolName }) => {
      if (toolName === "example_tool") return { allow: true };
    },
  });
}
```

Plugin id is inferred from `pluginId`/`id` exports or the file name.

## Behavior

- Plugin tools appear in `/tools`.
- Plugin hooks run before and after tool calls.
