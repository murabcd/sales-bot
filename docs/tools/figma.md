---
summary: "Figma tool integration"
read_when:
  - Setting up Figma tools
  - Debugging Figma tool calls
---
# Figma tools

Omni can read Figma data using a personal access token.

## Environment variables

Set these in your runtime environment or Cloudflare dashboard:

- `FIGMA_TOKEN` — Figma personal access token (secret)

If this is missing, Figma tools are not registered.

## Auth + reliability notes

- The bot uses the `X-Figma-Token` header (Figma PATs do not work with `Authorization: Bearer`).
- Large files can time out. The bot caps `depth` to 2 and retries on abort/timeout errors.
  If a request still fails, it falls back to a shallow `depth=1` fetch before retrying nodes.

## Tools

- `figma_me` — get current user profile.
- `figma_file_get` — get file metadata + document tree.
- `figma_file_nodes_get` — get specific nodes from a file.
- `figma_file_comments_list` — list comments on a file.
- `figma_project_files_list` — list files in a project.

## Notes

- These tools are read-only.
