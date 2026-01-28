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

## Tools

- `figma_me` — get current user profile.
- `figma_file_get` — get file metadata + document tree.
- `figma_file_nodes_get` — get specific nodes from a file.
- `figma_file_comments_list` — list comments on a file.
- `figma_project_files_list` — list files in a project.

## Notes

- These tools are read-only.
