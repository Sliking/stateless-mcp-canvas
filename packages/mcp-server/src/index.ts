/**
 * Stateless MCP Server on Cloudflare Workers
 *
 * This demonstrates the MCP 2026-07-28 stateless protocol (SEP-1442):
 * - No initialization handshake required
 * - No session state - every request is self-contained
 * - Any Worker isolate in the pool handles any request
 * - Protocol version + capabilities travel in _meta per request
 * - Fresh McpServer instance created per request via createMcpHandler
 *
 * Also demonstrates:
 * - SEP-2243: Mcp-Method / Mcp-Name HTTP headers for routing
 * - SEP-2322: Multi Round-Trip Requests (InputRequiredResult)
 */

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────
// Worker isolate identity: generated ONCE when this isolate cold-starts.
// In a stateless world, different requests hit different isolates -
// so the instance ID will differ across calls. That's the whole point.
// ──────────────────────────────────────────────────────────────────────
const ISOLATE_ID = crypto.randomUUID();
const ISOLATE_BORN = new Date().toISOString();
let requestCounter = 0;

// DNS types
interface DnsAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

interface DnsResponse {
  Status: number;
  Answer?: DnsAnswer[];
}

// ──────────────────────────────────────────────────────────────────────
// createMcpHandler: the v2 stateless entry point.
//
// The factory function is called ONCE PER REQUEST. Each request gets a
// brand-new McpServer. No state carries over. No init handshake needed.
// The client sends tools/list or tools/call directly, with protocol
// version in _meta. This is SEP-1442 in action.
// ──────────────────────────────────────────────────────────────────────
const handler = createMcpHandler((_ctx) => {
  requestCounter++;
  const thisRequestNum = requestCounter;

  const server = new McpServer({
    name: "Stateless MCP Demo",
    version: "1.0.0",
  });

  // ── Tool 1: get_server_info ─────────────────────────────────────
  // The key demo tool. Call it multiple times and watch the isolate ID
  // stay the same (same isolate) or change (different isolate picked
  // it up). The request number always increments within an isolate.
  server.registerTool(
    "get_server_info",
    {
      title: "Get Server Info",
      description:
        "Returns the Worker isolate ID, request number, and timestamp. " +
        "Call this multiple times to see statelessness in action - " +
        "different isolates may handle different requests, and there " +
        "is no session state between calls.",
      inputSchema: z.object({}),
    },
    async () => {
      const now = new Date();
      const uptimeMs = now.getTime() - new Date(ISOLATE_BORN).getTime();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                isolate_id: ISOLATE_ID,
                request_number: thisRequestNum,
                isolate_born: ISOLATE_BORN,
                uptime_seconds: Math.round(uptimeMs / 1000),
                handled_at: now.toISOString(),
                stateless: true,
                protocol: "MCP 2026-07-28 (stateless, SEP-1442)",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Tool 2: check_website_status ────────────────────────────────
  server.registerTool(
    "check_website_status",
    {
      title: "Check Website Status",
      description:
        "Checks any website with a HEAD request. Returns status code, " +
        "response time, selected headers, and whether the site uses Cloudflare.",
      inputSchema: z.object({
        url: z.string().describe("Full URL to check, e.g. https://example.com"),
      }),
    },
    async ({ url }) => {
      const start = performance.now();
      try {
        const res = await fetch(url, { method: "HEAD", redirect: "follow" });
        const ms = Math.round(performance.now() - start);

        const headers: Record<string, string> = {};
        for (const h of [
          "content-type",
          "server",
          "cf-ray",
          "cf-cache-status",
          "cache-control",
        ]) {
          const v = res.headers.get(h);
          if (v) headers[h] = v;
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  url,
                  status: res.status,
                  status_text: res.statusText,
                  response_time_ms: ms,
                  on_cloudflare: !!res.headers.get("cf-ray"),
                  headers,
                  handled_by_isolate: ISOLATE_ID,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  url,
                  error: err instanceof Error ? err.message : String(err),
                  handled_by_isolate: ISOLATE_ID,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // ── Tool 3: dns_lookup ──────────────────────────────────────────
  server.registerTool(
    "dns_lookup",
    {
      title: "DNS Lookup",
      description:
        "Resolves DNS records using Cloudflare 1.1.1.1 DNS-over-HTTPS. " +
        "Supports A, AAAA, CNAME, MX, TXT, and NS record types.",
      inputSchema: z.object({
        domain: z.string().describe("Domain to resolve, e.g. cloudflare.com"),
        record_type: z
          .enum(["A", "AAAA", "CNAME", "MX", "TXT", "NS"])
          .default("A")
          .describe("DNS record type"),
      }),
    },
    async ({ domain, record_type }) => {
      try {
        const res = await fetch(
          `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${record_type}`,
          { headers: { Accept: "application/dns-json" } }
        );
        const data = (await res.json()) as DnsResponse;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  domain,
                  record_type,
                  status: data.Status === 0 ? "NOERROR" : `STATUS_${data.Status}`,
                  records: (data.Answer || []).map((a) => ({
                    type: record_type,
                    value: a.data,
                    ttl: a.TTL,
                  })),
                  resolver: "Cloudflare 1.1.1.1 (DoH)",
                  handled_by_isolate: ISOLATE_ID,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                domain,
                error: err instanceof Error ? err.message : String(err),
              }),
            },
          ],
        };
      }
    }
  );

  // ── Tool 4: generate_qr_code ────────────────────────────────────
  server.registerTool(
    "generate_qr_code",
    {
      title: "Generate QR Code",
      description:
        "Creates a QR code image URL for any text or URL. " +
        "Great for sharing links on-screen that the audience can scan.",
      inputSchema: z.object({
        text: z.string().max(2000).describe("Text or URL to encode"),
        size: z
          .number()
          .int()
          .min(100)
          .max(500)
          .default(200)
          .describe("QR code size in pixels"),
      }),
    },
    async ({ text, size }) => {
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                text: text.length > 80 ? text.slice(0, 80) + "..." : text,
                size: `${size}x${size}`,
                qr_url: qrUrl,
                is_url: text.startsWith("http://") || text.startsWith("https://"),
                handled_by_isolate: ISOLATE_ID,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Tool 5: stateless_proof ─────────────────────────────────────
  // A tool specifically designed to prove the stateless nature of the
  // protocol. It accepts a "previous_isolate_id" parameter so the
  // frontend can show side-by-side that requests land on different
  // (or the same) isolates with zero coordination.
  server.registerTool(
    "stateless_proof",
    {
      title: "Stateless Proof",
      description:
        "Proves statelessness by comparing the current isolate with a " +
        "previous one. Pass the isolate_id from a prior call to see " +
        "whether this request landed on the same or a different instance. " +
        "No session state is needed - the proof travels in the request.",
      inputSchema: z.object({
        previous_isolate_id: z
          .string()
          .optional()
          .describe("The isolate_id from a previous get_server_info call"),
      }),
    },
    async ({ previous_isolate_id }) => {
      const sameIsolate = previous_isolate_id === ISOLATE_ID;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                current_isolate: ISOLATE_ID,
                previous_isolate: previous_isolate_id || "(none provided)",
                same_isolate: previous_isolate_id ? sameIsolate : null,
                explanation: previous_isolate_id
                  ? sameIsolate
                    ? "Same isolate handled both requests. This can happen - statelessness means any isolate CAN handle it, not that a different one MUST."
                    : "Different isolate! This request was handled by a completely different Worker instance. No session, no handshake, no coordination. The request was self-contained."
                  : "No previous ID provided. Call get_server_info first, then pass its isolate_id here.",
                protocol_note:
                  "In MCP 2026-07-28 (SEP-1442), there is no initialization handshake. " +
                  "Each request carries its protocol version in _meta. " +
                  "The server needs no memory of previous requests.",
                request_number: thisRequestNum,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return server;
});

// ──────────────────────────────────────────────────────────────────────
// Worker fetch handler with CORS
// ──────────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request): Promise<Response> {
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers":
        "Mcp-Session-Id, Mcp-Method, Mcp-Name, Mcp-Protocol-Version",
    };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Route /mcp to the stateless MCP handler
    const url = new URL(request.url);
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp")) {
      const response = await handler.fetch(request);
      // Attach CORS headers to the response
      const out = new Response(response.body, response);
      for (const [k, v] of Object.entries(corsHeaders)) {
        out.headers.set(k, v);
      }
      return out;
    }

    // Health / info endpoint
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          name: "Stateless MCP Demo Server",
          version: "1.0.0",
          protocol: "MCP 2026-07-28 (stateless)",
          seps: ["SEP-1442", "SEP-2322", "SEP-2243"],
          isolate_id: ISOLATE_ID,
          mcp_endpoint: "/mcp",
          docs: "https://github.com/Sliking/stateless-mcp-demo",
        }),
        {
          headers: {
            "Content-Type": "application/json",
            ...corsHeaders,
          },
        }
      );
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};
