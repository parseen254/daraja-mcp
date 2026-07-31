# Install per client

All of these run in simulator mode with no credentials. Add an `env` block when
you are ready to point at the real thing.

## Claude Code

```bash
claude mcp add daraja -- npx -y daraja-mcp
```

With credentials:

```bash
claude mcp add daraja \
  --env DARAJA_CONSUMER_KEY=your-key \
  --env DARAJA_CONSUMER_SECRET=your-secret \
  --env DARAJA_SHORTCODE=174379 \
  --env DARAJA_PASSKEY=your-passkey \
  --env DARAJA_CALLBACK_PUBLIC_URL=https://your-tunnel.ngrok.io \
  -- npx -y daraja-mcp
```

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows.

```json
{
  "mcpServers": {
    "daraja": {
      "command": "npx",
      "args": ["-y", "daraja-mcp"]
    }
  }
}
```

Restart the app after editing.

## Cursor

`.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` globally.

```json
{
  "mcpServers": {
    "daraja": {
      "command": "npx",
      "args": ["-y", "daraja-mcp"]
    }
  }
}
```

## VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "daraja": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "daraja-mcp"]
    }
  }
}
```

## Zed

`settings.json`:

```json
{
  "context_servers": {
    "daraja": {
      "command": {
        "path": "npx",
        "args": ["-y", "daraja-mcp"]
      }
    }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "daraja": {
      "command": "npx",
      "args": ["-y", "daraja-mcp"]
    }
  }
}
```

## Keeping credentials out of config files

The examples inline credentials for clarity, which is fine for sandbox and bad
for production. Most clients inherit the shell environment, so prefer:

```bash
export DARAJA_CONSUMER_KEY=...
export DARAJA_CONSUMER_SECRET=...
```

in your shell profile or a secret manager, and leave `env` out of the JSON.

A config file with production M-Pesa credentials is a file that eventually gets
committed.
