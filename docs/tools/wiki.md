---
summary: "Yandex Wiki tool integration"
read_when:
  - Setting up Yandex Wiki tools
  - Debugging Wiki tool calls
---
# Yandex Wiki tools

Omni can read and write Yandex Wiki pages using an OAuth token.

## Environment variables

Set these in your runtime environment or Cloudflare dashboard:

- `WIKI_TOKEN` — OAuth token (secret)
- `WIKI_CLOUD_ORG_ID` — Yandex Cloud org id (required for Cloud orgs)

If any of these are missing, Wiki tools are not registered.

## Tools

- `wiki_page_get` — get page details by slug.
- `wiki_page_get_by_id` — get page details by id.
- `wiki_page_create` — create a new page.
- `wiki_page_update` — update a page title/content.
- `wiki_page_append_content` — append content to a page.

## Notes

- `wiki_page_create` defaults to `page_type=wysiwyg` unless overridden.
- Consider adding write tools to `TOOL_APPROVAL_REQUIRED` for safety.
