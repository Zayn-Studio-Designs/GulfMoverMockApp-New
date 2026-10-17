GULF MOVER — CLAUDE CODE BUILD PACK

Status: Build handoff prepared; local implementation has not yet run.

Start with the Google Docs runbook:
https://docs.google.com/document/d/1bZ7GC4Z-7ta1BaWinHroeLHXR4B5Ogrv5Auin7BKh_Q/edit

The companion ZIP is available in the current ChatGPT conversation as:
gulf_mover_claude_code_build_pack.zip

The ZIP contains:
- CLAUDE.md: persistent project instructions
- CLAUDE_CODE_BUILD_PROMPT.md: full copy/paste build prompt
- .claude/agents/gulf-mover-requirements-analyst.md
- .claude/agents/gulf-mover-ux-rtl-reviewer.md
- .claude/agents/gulf-mover-workflow-reviewer.md
- .claude/agents/gulf-mover-drive-source-auditor.md
- .claude/agents/gulf-mover-qa-reviewer.md
- README.md: Drive MCP setup and run instructions

Instructions:
1. Download the ZIP from ChatGPT.
2. Extract into ~/Desktop/GulfMoverMockApp (create this as a clean new folder).
3. Set up the official Google Drive MCP for Claude Code using the instructions in the runbook. Google labels the connector Developer Preview; if access is blocked, use the runbook's local-reference fallback.
4. Start Claude Code from the new folder and paste CLAUDE_CODE_BUILD_PROMPT.md into the session.
5. Ask it to read the full Gulf Mover project folder and its nested folders only; use parallel read-only subagents first, then one main integration agent and independent QA.
6. Do not deploy or modify Drive source documents during the build. This phase is a local mock app only.

Relevant project root:
https://drive.google.com/drive/folders/1euoAzTJiUdTcbWGTMxf7bJzxFZmuYBFZ

Current latest bilingual prototype in Drive:
https://drive.google.com/file/d/1sfwKimIUneqm2PvoddHnIPK2PifosbES/view

Do not mark the app as implemented until Claude Code has actually built it and reported real build/test evidence.
