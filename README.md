# Stateless MCP Canvas

A collaborative pixel art canvas powered by **stateless MCP** on Cloudflare Workers.

Everyone draws on the same 32x32 canvas from their phones. Every pixel tap is a single stateless MCP tool call - no handshake, no session, no state on the server. The canvas state lives in Cloudflare KV. The MCP server is stateless. The protocol is stateless.

**Live demo:** [canvas.mpinto.space](https://canvas.mpinto.space)

## How it works

You tap a pixel on your phone. That tap becomes a `tools/call` request to the MCP server with the protocol version embedded in `_meta`. No initialization ceremony - just one HTTP POST. Any Worker isolate in the pool picks it up, writes the pixel to KV, and responds. The frontend polls `get_canvas` every 2 seconds to sync everyone's pixels.

```
Phones at the event (tap to draw)
    |
    |  POST /mcp  { method: "tools/call", params: { name: "place_pixel", ... } }
    |  No init handshake. Protocol version in _meta. Any isolate handles it.
    v
+--------------------------+     +----------------+
| MCP Server (Workers)     |---->| KV (canvas)    |
| createMcpHandler (v2)    |<----| shared state   |
| Fresh McpServer per req  |     +----------------+
| No sessions, no DO       |
+--------------------------+
```

## What makes this "stateless"?

Traditional MCP requires a 3-step initialization handshake before any work can happen. This skips it entirely:

| Traditional MCP (v1) | Stateless MCP (2026-07-28) |
|---|---|
| 1. `initialize` request | 1. `tools/call` directly |
| 2. `notifications/initialized` | Protocol version in `_meta` |
| 3. Now you can call tools | That's it. One request. |

This implements the protocol-level changes from:
- [SEP-1442](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1442) - Make MCP stateless by default (no init handshake)
- [SEP-2243](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2243) - HTTP standardization (`Mcp-Method` / `Mcp-Name` headers)
- [SEP-2322](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322) - Multi round-trip requests

## MCP Tools

| Tool | Description |
|------|-------------|
| `place_pixel` | Place a colored pixel at (x, y) with your nickname |
| `get_canvas` | Get all pixels on the 32x32 canvas |
| `get_stats` | Total pixels, unique artists, unique isolates, top colors |
| `clear_canvas` | Reset the canvas (requires confirmation) |

## Stack

- **MCP Server** - Cloudflare Workers + `@modelcontextprotocol/server` v2 (beta) + KV
- **Frontend** - Astro (static) on Cloudflare Workers
- **Canvas state** - Cloudflare KV (external store, not in the MCP server)
- **No Durable Objects** - the MCP server is purely stateless

## Quick start

```bash
git clone https://github.com/Sliking/stateless-mcp-canvas
cd stateless-mcp-canvas

# Install
npm install --workspaces

# Run MCP server (port 8787)
npm run dev:server

# Run frontend (port 4321)
npm run dev:frontend
```

## Deploy

```bash
npm run deploy:server
npm run deploy:frontend
```

## Key files

- `packages/mcp-server/src/index.ts` - Stateless MCP server using `createMcpHandler` (v2 SDK)
- `packages/frontend/src/pages/index.astro` - Mobile-first pixel canvas with stateless MCP client
- No `initialize` calls anywhere - that's the point

## Live URLs

| | URL |
|---|---|
| Canvas | [canvas.mpinto.space](https://canvas.mpinto.space) |
| MCP Server | [mcp.mpinto.space/mcp](https://mcp.mpinto.space/mcp) |

## References

- [Stateless: The Future of MCP Transports](https://aaif.io/blog/stateless-the-future-of-mcp-transports) - Shaun Smith (Hugging Face) & Kurtis Van Gent (Google) at MCP Dev Summit
- [SEP-1442: Make MCP Stateless](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1442) - The core spec change
- [SEP-2322: Multi Round-Trip Requests](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322) - Stateless elicitation
- [SEP-2243: HTTP Standardization](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2243) - Header-based routing
- [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) - Reference implementation
