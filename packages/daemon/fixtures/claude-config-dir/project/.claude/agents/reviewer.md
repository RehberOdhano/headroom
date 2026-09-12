---
name: reviewer
description: Read-only reviewer used only in daemon fixtures, not real conversation content.
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit, NotebookEdit
model: inherit
---

Body content is irrelevant to agent discovery — only the frontmatter is parsed.
