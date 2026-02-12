# mcp-codexreview

[![npm version](https://img.shields.io/npm/v/mcp-codexreview.svg)](https://www.npmjs.com/package/mcp-codexreview)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MCP server that runs [OpenAI Codex CLI](https://github.com/openai/codex) (`codex exec`) to review git changes. Any MCP client (Claude Code, etc.) can request a Codex-powered code review of unstaged, staged, or last-commit changes.

## Prerequisites

- Node.js 18+
- `@openai/codex` CLI installed and available on `$PATH`
- Codex configured with an API key (via `~/.codex/config.toml` or environment)

## Installation

### Claude Code

```bash
claude mcp add codexreview -- npx -y mcp-codexreview
```

### Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "codexreview": {
      "command": "npx",
      "args": ["-y", "mcp-codexreview"]
    }
  }
}
```

### Install from Source

```bash
git clone https://github.com/signal-slot/mcp-codexreview.git
cd mcp-codexreview
npm install
npm run build
claude mcp add codexreview -- node /path/to/mcp-codexreview/build/index.js
```

## MCP Tools

### `review_changes`

Run Codex to review git changes. Codex reads the diff and provides a thorough code review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"unstaged" \| "staged" \| "last_commit"` | yes | Which changes to review |
| `cwd` | `string` | no | Git repo path (default: server working directory) |
| `model` | `string` | no | Override Codex model (e.g. `"o3"`, `"gpt-4.1"`) |
| `instructions` | `string` | no | Additional review focus or instructions |

### `get_diff`

Get raw git diff output without invoking Codex.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"unstaged" \| "staged" \| "last_commit"` | yes | Which changes to diff |
| `path` | `string` | no | Filter to specific file or directory |
| `cwd` | `string` | no | Git repo path |

### `get_changed_files`

List changed files with their status (M/A/D/R).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `type` | `"unstaged" \| "staged" \| "last_commit"` | yes | Which changes to list |
| `cwd` | `string` | no | Git repo path |

## How It Works

The `review_changes` tool spawns `codex exec` with:
- `-C <cwd>` to target the git repo
- `-s read-only` sandbox (Codex can read files and run git, but cannot modify)
- `-a on-failure` for non-interactive execution
- `--output-last-message <tmpfile>` to capture the review text
- `--color never` for clean output

The review prompt instructs Codex to run the appropriate `git diff` command and provide a code review covering correctness, style, performance, security, and improvement suggestions.

## License

MIT
