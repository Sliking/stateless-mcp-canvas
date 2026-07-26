/**
 * Stateless MCP Pixel Art Canvas Server
 *
 * A collaborative 32x32 pixel art canvas where every pixel placement is a
 * stateless MCP tool call. Canvas state lives in Cloudflare KV (external state),
 * while the MCP server itself is fully stateless (fresh McpServer per request).
 *
 * This demonstrates the MCP 2026-07-28 stateless protocol (SEP-1442):
 * - No initialization handshake required
 * - No session state - every request is self-contained
 * - Any Worker isolate in the pool handles any request
 * - Protocol version + capabilities travel in _meta per request
 * - Fresh McpServer instance created per request via createMcpHandler
 */

import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────
// Environment bindings
// ──────────────────────────────────────────────────────────────────────
interface Env {
  CANVAS_KV: KVNamespace;
}

// Module-level variable to capture env from fetch handler
let currentEnv: Env;

// ──────────────────────────────────────────────────────────────────────
// Canvas data types
// ──────────────────────────────────────────────────────────────────────
interface Pixel {
  x: number;
  y: number;
  color: string;
  placed_by: string;
  isolate_id: string;
  timestamp: string;
}

interface Canvas {
  pixels: Record<string, Pixel>; // key is "x,y"
  created_at: string;
  last_updated: string;
}

interface CanvasStats {
  total_pixels_placed: number;
  unique_artists: string[];
  unique_isolates: string[];
  color_counts: Record<string, number>;
}

// KV keys
const CANVAS_KEY = "canvas:current";
const STATS_KEY = "canvas:stats";

// Canvas dimensions
const CANVAS_WIDTH = 32;
const CANVAS_HEIGHT = 32;

// ──────────────────────────────────────────────────────────────────────
// Worker isolate identity: generated lazily on first request.
// In a stateless world, different requests hit different isolates -
// so the instance ID will differ across calls. That's the whole point.
// (crypto.randomUUID() can't be called in global scope on Workers)
// ──────────────────────────────────────────────────────────────────────
let ISOLATE_ID = "";
let ISOLATE_BORN = "";
let requestCounter = 0;

function getIsolateId(): string {
  if (!ISOLATE_ID) {
    ISOLATE_ID = crypto.randomUUID();
    ISOLATE_BORN = new Date().toISOString();
  }
  return ISOLATE_ID;
}

// ──────────────────────────────────────────────────────────────────────
// Canvas helper functions
// ──────────────────────────────────────────────────────────────────────
async function getCanvas(kv: KVNamespace): Promise<Canvas> {
  const data = await kv.get(CANVAS_KEY, "json");
  if (data) {
    return data as Canvas;
  }
  // Initialize empty canvas
  const now = new Date().toISOString();
  return {
    pixels: {},
    created_at: now,
    last_updated: now,
  };
}

async function saveCanvas(kv: KVNamespace, canvas: Canvas): Promise<void> {
  canvas.last_updated = new Date().toISOString();
  await kv.put(CANVAS_KEY, JSON.stringify(canvas));
}

async function getStats(kv: KVNamespace): Promise<CanvasStats> {
  const data = await kv.get(STATS_KEY, "json");
  if (data) {
    return data as CanvasStats;
  }
  return {
    total_pixels_placed: 0,
    unique_artists: [],
    unique_isolates: [],
    color_counts: {},
  };
}

async function saveStats(kv: KVNamespace, stats: CanvasStats): Promise<void> {
  await kv.put(STATS_KEY, JSON.stringify(stats));
}

async function updateStats(
  kv: KVNamespace,
  nickname: string,
  color: string,
  isolateId: string
): Promise<void> {
  const stats = await getStats(kv);

  stats.total_pixels_placed++;

  if (!stats.unique_artists.includes(nickname)) {
    stats.unique_artists.push(nickname);
  }

  if (!stats.unique_isolates.includes(isolateId)) {
    stats.unique_isolates.push(isolateId);
  }

  stats.color_counts[color] = (stats.color_counts[color] || 0) + 1;

  await saveStats(kv, stats);
}

function computeCanvasStats(canvas: Canvas, stats: CanvasStats): {
  total_pixels_on_canvas: number;
  total_pixels_placed: number;
  unique_artists_count: number;
  unique_isolates_count: number;
  fill_percentage: number;
  most_used_colors: Array<{ color: string; count: number }>;
} {
  const pixelCount = Object.keys(canvas.pixels).length;
  const totalCells = CANVAS_WIDTH * CANVAS_HEIGHT;

  // Sort colors by usage
  const colorEntries = Object.entries(stats.color_counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([color, count]) => ({ color, count }));

  return {
    total_pixels_on_canvas: pixelCount,
    total_pixels_placed: stats.total_pixels_placed,
    unique_artists_count: stats.unique_artists.length,
    unique_isolates_count: stats.unique_isolates.length,
    fill_percentage: Math.round((pixelCount / totalCells) * 100 * 10) / 10,
    most_used_colors: colorEntries,
  };
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
  const env = currentEnv; // captured from fetch

  const server = new McpServer({
    name: "Pixel Canvas MCP Server",
    version: "1.0.0",
  });

  // ── Tool 1: place_pixel ─────────────────────────────────────────
  // The main tool. Each phone tap = one place_pixel call.
  server.registerTool(
    "place_pixel",
    {
      title: "Place Pixel",
      description:
        "Place a single pixel on the 32x32 collaborative canvas. " +
        "Each placement is a stateless MCP call - the canvas state lives in KV.",
      inputSchema: z.object({
        x: z
          .number()
          .int()
          .min(0)
          .max(31)
          .describe("X coordinate (0-31, left to right)"),
        y: z
          .number()
          .int()
          .min(0)
          .max(31)
          .describe("Y coordinate (0-31, top to bottom)"),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .describe('Hex color string like "#ff6600"'),
        nickname: z
          .string()
          .max(32)
          .optional()
          .describe("Your nickname (default: anonymous)"),
      }),
    },
    async ({ x, y, color, nickname }) => {
      const artist = nickname || "anonymous";
      const isolateId = getIsolateId();
      const timestamp = new Date().toISOString();

      // Read current canvas
      const canvas = await getCanvas(env.CANVAS_KV);

      // Create the pixel
      const pixel: Pixel = {
        x,
        y,
        color: color.toLowerCase(),
        placed_by: artist,
        isolate_id: isolateId,
        timestamp,
      };

      // Update canvas
      const key = `${x},${y}`;
      canvas.pixels[key] = pixel;

      // Save canvas and update stats
      await saveCanvas(env.CANVAS_KV, canvas);
      await updateStats(env.CANVAS_KV, artist, color.toLowerCase(), isolateId);

      const totalPixels = Object.keys(canvas.pixels).length;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                pixel: {
                  x,
                  y,
                  color: color.toLowerCase(),
                  placed_by: artist,
                  timestamp,
                },
                canvas_stats: {
                  total_pixels: totalPixels,
                  fill_percentage:
                    Math.round(
                      (totalPixels / (CANVAS_WIDTH * CANVAS_HEIGHT)) * 100 * 10
                    ) / 10,
                },
                handled_by_isolate: isolateId,
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

  // ── Tool 2: get_canvas ──────────────────────────────────────────
  // Returns the full canvas state.
  server.registerTool(
    "get_canvas",
    {
      title: "Get Canvas",
      description:
        "Returns the full 32x32 pixel canvas state. " +
        "All non-empty pixels are returned with their color, artist, and placement info.",
      inputSchema: z.object({}),
    },
    async () => {
      const canvas = await getCanvas(env.CANVAS_KV);
      const stats = await getStats(env.CANVAS_KV);
      const isolateId = getIsolateId();

      // Convert pixels object to array
      const pixelsArray = Object.values(canvas.pixels);

      // Get online users by listing presence keys
      const presenceList = await env.CANVAS_KV.list({ prefix: "presence:" });
      const onlineUsers: string[] = [];
      for (const key of presenceList.keys) {
        const name = key.name.replace("presence:", "");
        if (name) onlineUsers.push(name);
      }

      // Compute leaderboard from canvas pixels (with colors used)
      const artistData: Record<string, { count: number; colors: Record<string, number> }> = {};
      for (const pixel of pixelsArray) {
        const name = pixel.placed_by || "anonymous";
        if (!artistData[name]) artistData[name] = { count: 0, colors: {} };
        artistData[name].count++;
        artistData[name].colors[pixel.color] = (artistData[name].colors[pixel.color] || 0) + 1;
      }
      const leaderboard = Object.entries(artistData)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([name, data], rank) => ({
          rank: rank + 1,
          name,
          pixels: data.count,
          colors: Object.entries(data.colors)
            .sort((a, b) => b[1] - a[1])
            .map(([color]) => color),
        }));

      const computedStats = computeCanvasStats(canvas, stats);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                canvas: {
                  width: CANVAS_WIDTH,
                  height: CANVAS_HEIGHT,
                  created_at: canvas.created_at,
                  last_updated: canvas.last_updated,
                  pixels: pixelsArray,
                },
                metadata: {
                  total_pixels: pixelsArray.length,
                  unique_artists: computedStats.unique_artists_count,
                  fill_percentage: computedStats.fill_percentage,
                },
                online_users: onlineUsers,
                leaderboard: leaderboard,
                handled_by_isolate: isolateId,
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

  // ── Tool 3: get_stats ───────────────────────────────────────────
  // Returns detailed canvas statistics.
  server.registerTool(
    "get_stats",
    {
      title: "Get Canvas Stats",
      description:
        "Returns detailed statistics about the collaborative canvas: " +
        "total pixels placed, unique artists, unique isolates, most used colors, and fill percentage.",
      inputSchema: z.object({}),
    },
    async () => {
      const canvas = await getCanvas(env.CANVAS_KV);
      const stats = await getStats(env.CANVAS_KV);
      const isolateId = getIsolateId();

      const computedStats = computeCanvasStats(canvas, stats);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                stats: {
                  canvas_dimensions: `${CANVAS_WIDTH}x${CANVAS_HEIGHT}`,
                  total_cells: CANVAS_WIDTH * CANVAS_HEIGHT,
                  pixels_on_canvas: computedStats.total_pixels_on_canvas,
                  total_placements: computedStats.total_pixels_placed,
                  fill_percentage: computedStats.fill_percentage,
                  unique_artists: {
                    count: computedStats.unique_artists_count,
                    names: stats.unique_artists,
                  },
                  unique_isolates: {
                    count: computedStats.unique_isolates_count,
                    note: "Each unique isolate is a different Worker instance that handled a request",
                    ids: stats.unique_isolates,
                  },
                  most_used_colors: computedStats.most_used_colors,
                },
                handled_by_isolate: isolateId,
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

  // ── Tool 4: clear_canvas ────────────────────────────────────────
  // Clears the canvas (requires confirmation).
  server.registerTool(
    "clear_canvas",
    {
      title: "Clear Canvas",
      description:
        "Clears the entire canvas. Requires confirmation by passing 'yes' as the confirm parameter.",
      inputSchema: z.object({
        confirm: z
          .string()
          .describe("Must be exactly 'yes' to confirm clearing the canvas"),
      }),
    },
    async ({ confirm }) => {
      const isolateId = getIsolateId();

      if (confirm !== "yes") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error:
                    "Confirmation required. Pass confirm: 'yes' to clear the canvas.",
                  handled_by_isolate: isolateId,
                  request_number: thisRequestNum,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Get stats before clearing for the response
      const oldCanvas = await getCanvas(env.CANVAS_KV);
      const oldStats = await getStats(env.CANVAS_KV);
      const oldPixelCount = Object.keys(oldCanvas.pixels).length;

      // Clear canvas
      const now = new Date().toISOString();
      const newCanvas: Canvas = {
        pixels: {},
        created_at: now,
        last_updated: now,
      };

      // Reset stats
      const newStats: CanvasStats = {
        total_pixels_placed: 0,
        unique_artists: [],
        unique_isolates: [],
        color_counts: {},
      };

      await saveCanvas(env.CANVAS_KV, newCanvas);
      await saveStats(env.CANVAS_KV, newStats);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                message: "Canvas cleared!",
                cleared: {
                  pixels_removed: oldPixelCount,
                  artists_reset: oldStats.unique_artists.length,
                  total_placements_before: oldStats.total_pixels_placed,
                },
                cleared_at: now,
                handled_by_isolate: isolateId,
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

  // ── Tool 5: heartbeat ───────────────────────────────────────────
  // Registers presence with TTL for online user tracking.
  server.registerTool(
    "heartbeat",
    {
      title: "Heartbeat",
      description: "Send a heartbeat to register your presence on the canvas. Called automatically by the frontend.",
      inputSchema: z.object({
        nickname: z.string().max(32).describe("Your nickname"),
      }),
    },
    async ({ nickname }) => {
      const isolateId = getIsolateId();
      // Store presence with 15 second TTL
      await env.CANVAS_KV.put(
        `presence:${nickname}`,
        JSON.stringify({ nickname, last_seen: new Date().toISOString(), isolate_id: isolateId }),
        { expirationTtl: 15 }
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            handled_by_isolate: isolateId,
          }),
        }],
      };
    }
  );

  return server;
});

// ──────────────────────────────────────────────────────────────────────
// Worker fetch handler with CORS
// ──────────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Capture env for the MCP handler
    currentEnv = env;

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

    // Health / info endpoint with canvas stats
    if (url.pathname === "/" || url.pathname === "/health") {
      const canvas = await getCanvas(env.CANVAS_KV);
      const stats = await getStats(env.CANVAS_KV);
      const computedStats = computeCanvasStats(canvas, stats);

      // Get online user count
      const presenceList = await env.CANVAS_KV.list({ prefix: "presence:" });

      return new Response(
        JSON.stringify(
          {
            name: "Pixel Canvas MCP Server",
            version: "1.0.0",
            protocol: "MCP 2026-07-28 (stateless)",
            seps: ["SEP-1442", "SEP-2322", "SEP-2243"],
            isolate_id: getIsolateId(),
            isolate_born: ISOLATE_BORN,
            request_count: requestCounter,
            mcp_endpoint: "/mcp",
            canvas: {
              dimensions: `${CANVAS_WIDTH}x${CANVAS_HEIGHT}`,
              pixels_placed: computedStats.total_pixels_on_canvas,
              total_placements: computedStats.total_pixels_placed,
              fill_percentage: computedStats.fill_percentage,
              unique_artists: computedStats.unique_artists_count,
              unique_isolates: computedStats.unique_isolates_count,
              most_popular_colors: computedStats.most_used_colors.slice(0, 5),
            },
            online_users: presenceList.keys.length,
            tools: ["place_pixel", "get_canvas", "get_stats", "clear_canvas", "heartbeat"],
          },
          null,
          2
        ),
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
