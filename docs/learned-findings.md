---
summary: "Guidance for what to store as durable learnings"
read_when:
  - Deciding whether to call addMemory
---
# Learned Findings Guidance

What counts as a learning (non-obvious discoveries only):
- Hidden relationships between files or modules
- Execution paths that differ from how code appears
- Non-obvious configuration, env vars, or flags
- Debugging breakthroughs when error messages were misleading
- API/tool quirks and workarounds
- Build/test commands not in README
- Architectural decisions and constraints
- Files that must change together

What NOT to include:
- Obvious facts from documentation
- Standard language/framework behavior
- Things already in AGENTS.md
- Verbose explanations
- Session-specific details

Process:
- Review session for discoveries and unexpected connections
- Note scope (directory where it applies)
- Keep entries to 1-3 lines per insight
