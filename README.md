# Stateless MCP Demo

A demo of the **MCP 2026-07-28 stateless protocol** running on Cloudflare Workers, with a mobile-friendly Astro frontend.

This project demonstrates the protocol-level changes from [SEP-1442](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1442) (stateless MCP), [SEP-2322](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322) (multi round-trip requests), and [SEP-2243](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2243) (HTTP header standardization).

## What makes this "stateless"?

Traditional MCP requires a **3-step initialization handshake** before any work can happen. This demo skips it entirely:

| Traditional MCP (v1) | Stateless MCP (2026-07-28) |
|---|---|
| 1. `initialize` request | 1. `tools/list` (protocol version in `_meta`) |
| 2. `notifications/initialized` | That's it. One request. |
| 3. `tools/list` | |

- **No session state** -- every request is self-contained
- **No Durable Objects** -- pure stateless Workers, any isolate handles any request
- **Protocol version in `_meta`** -- no handshake negotiation needed
- **`Mcp-Method` / `Mcp-Name` HTTP headers** -- load balancers and proxies can route without parsing JSON-RPC bodies

## Architecture

```
Phone / Browser
    |
    |  POST /mcp  (no init handshake, _meta carries protocol version)
    |  Headers: Mcp-Method: tools/call, Mcp-Name: dns_lookup
    v
+-------------------------------+     +---------------------------+
| Astro Frontend (Workers)      |     | MCP Server (Workers)      |
| - Mobile-first UI             |---->| - createMcpHandler (v2)   |
| - Stateless MCP client        |     | - Fresh McpServer per req |
| - Visual isolate tracking     |     | - No sessions, no DO      |
+-------------------------------+     +---------------------------+
```

## Demo tools

| Tool | What it shows |
|------|---------------|
| `get_server_info` | Returns the Worker isolate ID -- call it multiple times to see different isolates handle requests |
| `check_website_status` | HEAD request to any URL with timing and headers |
| `dns_lookup` | DNS resolution via Cloudflare 1.1.1.1 DoH |
| `generate_qr_code` | Creates a QR code URL -- scan it from the audience's phones |
| `stateless_proof` | Pass a previous isolate ID to prove requests are independent |

## Quick start

```bash
# Install dependencies
npm install --workspaces

# Start the MCP server (port 8787)
npm run dev:server

# In another terminal, start the frontend (port 4321)
npm run dev:frontend
```

Open http://localhost:4321 on your phone, enter `http://localhost:8787/mcp` as the server URL, and tap Connect.

## Deploy to Cloudflare

```bash
# Deploy the MCP server
npm run deploy:server

# Update the frontend's default URL to point to your deployed server
# Then deploy the frontend
npm run deploy:frontend
```

## Key files

- `packages/mcp-server/src/index.ts` -- Stateless MCP server using `createMcpHandler` (v2 SDK)
- `packages/frontend/src/pages/index.astro` -- Mobile-first MCP client UI
- No `initialize` calls anywhere -- that's the point

## References

- [Stateless: The Future of MCP Transports](https://aaif.io/blog/stateless-the-future-of-mcp-transports) -- AAIF blog post
- [SEP-1442: Make MCP Stateless](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1442) -- The core spec change
- [SEP-2322: Multi Round-Trip Requests](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322) -- Stateless elicitation
- [SEP-2243: HTTP Standardization](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2243) -- Header-based routing
- [MCP TypeScript SDK v2](https://github.com/modelcontextprotocol/typescript-sdk/pull/2286) -- Reference implementation
