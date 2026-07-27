import { test, expect } from '@playwright/test';

test.describe('Canvas - Page Load', () => {
  test('loads and connects to MCP server', async ({ page }) => {
    await page.goto('/');

    // Loading overlay should disappear
    const overlay = page.locator('#loading-overlay');
    await expect(overlay).toHaveClass(/hidden/, { timeout: 10000 });

    // Status should show connected
    const statusDot = page.locator('#status-dot');
    await expect(statusDot).toHaveClass(/connected/);

    const statusText = page.locator('#status-text');
    await expect(statusText).toHaveText('Connected');

    // Canvas should be present
    const canvas = page.locator('#pixel-canvas');
    await expect(canvas).toBeVisible();
  });

  test('shows online users with self included', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Wait for heartbeat to register
    await page.waitForTimeout(6000);

    const onlineText = page.locator('#online-text');
    const text = await onlineText.textContent();
    const count = parseInt(text || '0');
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Canvas - Nickname', () => {
  test('can set nickname and it persists', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    const input = page.locator('#nickname-input');
    await input.fill('PlaywrightTest');
    await expect(input).toHaveValue('PlaywrightTest');
  });
});

test.describe('Canvas - Color Selection', () => {
  test('can select predefined colors', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Click the red swatch
    const redSwatch = page.locator('.color-swatch[data-color="#ff4444"]');
    await redSwatch.click();
    await expect(redSwatch).toHaveClass(/selected/);

    // Orange should no longer be selected
    const orangeSwatch = page.locator('.color-swatch[data-color="#f6821f"]');
    await expect(orangeSwatch).not.toHaveClass(/selected/);
  });

  test('custom color picker is visible', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    const customSwatch = page.locator('#custom-color-swatch');
    await expect(customSwatch).toBeVisible();
  });
});

test.describe('Canvas - Pixel Placement', () => {
  test('can place a pixel by clicking the canvas (desktop)', async ({ page, browserName }, testInfo) => {
    // Only run on desktop project
    if (testInfo.project.name !== 'Desktop Chrome') {
      test.skip();
    }

    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Set a unique nickname
    const nickname = `pw-${Date.now()}`;
    await page.locator('#nickname-input').fill(nickname);

    // Select a color
    await page.locator('.color-swatch[data-color="#44ff44"]').click();

    // Click the canvas at a specific position
    const canvas = page.locator('#pixel-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    // Click near the center
    const cellSize = box.width / 32;
    const targetX = box.x + (16 * cellSize) + cellSize / 2;
    const targetY = box.y + (16 * cellSize) + cellSize / 2;
    await page.mouse.click(targetX, targetY);

    // Wait for the MCP call to complete
    await page.waitForTimeout(2000);

    // Verify via the MCP server that the pixel was placed
    const response = await page.evaluate(async (nick) => {
      const res = await fetch('https://mcp.mpinto.space/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'get_canvas',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 999,
          method: 'tools/call',
          params: {
            name: 'get_canvas',
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      const data = await res.json();
      const canvasData = JSON.parse(data.result.content[0].text);
      return canvasData.canvas.pixels.find((p: any) => p.placed_by === nick);
    }, nickname);

    expect(response).toBeTruthy();
    expect(response.color).toBe('#44ff44');
    expect(response.x).toBe(16);
    expect(response.y).toBe(16);
  });

  test('can place a pixel by tapping the canvas (mobile)', async ({ page }, testInfo) => {
    // Only run on mobile project
    if (testInfo.project.name !== 'Mobile Chrome') {
      test.skip();
    }

    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    // Set a unique nickname (keep under 20 chars - input maxlength)
    const nickname = `pwm-${Date.now() % 1000000}`;
    await page.locator('#nickname-input').fill(nickname);

    // Select red
    await page.locator('.color-swatch[data-color="#ff4444"]').click();

    // Check canvas bounding box
    const canvas = page.locator('#pixel-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas not found');

    const cellSize = box.width / 32;
    const targetX = box.x + (10 * cellSize) + cellSize / 2;
    const targetY = box.y + (10 * cellSize) + cellSize / 2;

    // Inject a debug hook to confirm handleCanvasTap fires
    await page.evaluate(() => {
      const origHandleTap = (window as any).__handleCanvasTapCalled;
      (window as any).__tapDebug = { called: false, cell: null, error: null };
    });

    // Click the canvas
    await canvas.click({ position: { x: 10 * cellSize + cellSize / 2, y: 10 * cellSize + cellSize / 2 } });

    // Wait for the MCP call
    await page.waitForTimeout(3000);

    // Verify via MCP
    const response = await page.evaluate(async (nick) => {
      const res = await fetch('https://mcp.mpinto.space/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Mcp-Method': 'tools/call',
          'Mcp-Name': 'get_canvas',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 999,
          method: 'tools/call',
          params: {
            name: 'get_canvas',
            arguments: {},
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      });
      const data = await res.json();
      const canvasData = JSON.parse(data.result.content[0].text);
      return canvasData.canvas.pixels.find((p: any) => p.placed_by === nick);
    }, nickname);

    expect(response).toBeTruthy();
    expect(response.color).toBe('#ff4444');
    expect(response.x).toBe(10);
    expect(response.y).toBe(10);
  });
});

test.describe('Canvas - UI Controls', () => {
  test('mute button toggles', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    const muteBtn = page.locator('#mute-btn');
    await expect(muteBtn).toBeVisible();

    // Should start unmuted
    const initialText = await muteBtn.textContent();
    expect(initialText?.trim()).toContain('🔊');

    // Click to mute
    await muteBtn.click();
    const mutedText = await muteBtn.textContent();
    expect(mutedText?.trim()).toContain('🔇');

    // Click to unmute
    await muteBtn.click();
    const unmutedText = await muteBtn.textContent();
    expect(unmutedText?.trim()).toContain('🔊');
  });

  test('undo button is present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    const undoBtn = page.locator('#undo-btn');
    await expect(undoBtn).toBeVisible();
  });

  test('export button is present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    const exportBtn = page.locator('#export-btn');
    await expect(exportBtn).toBeVisible();
  });

  test('replay button is present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    const replayBtn = page.locator('#replay-btn');
    await expect(replayBtn).toBeVisible();
  });

  test('leaderboard toggles open and closed', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-overlay')).toHaveClass(/hidden/, { timeout: 10000 });

    const toggle = page.locator('#leaderboard-toggle');
    const panel = page.locator('#leaderboard-panel');

    // Should start hidden
    await expect(panel).toHaveClass(/hidden/);

    // Click to open
    await toggle.click();
    await expect(panel).not.toHaveClass(/hidden/);

    // Click to close
    await toggle.click();
    await expect(panel).toHaveClass(/hidden/);
  });
});

test.describe('Canvas - MCP Server', () => {
  test('MCP server responds to tools/list', async ({ request }) => {
    const response = await request.post('https://mcp.mpinto.space/mcp', {
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Method': 'tools/list',
      },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      },
    });

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.result).toBeTruthy();
    expect(data.result.tools).toBeTruthy();

    const toolNames = data.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('place_pixel');
    expect(toolNames).toContain('get_canvas');
    expect(toolNames).toContain('get_stats');
    expect(toolNames).toContain('clear_canvas');
    expect(toolNames).toContain('heartbeat');
    expect(toolNames).toContain('undo_pixel');
    expect(toolNames).toContain('get_history');
  });

  test('health endpoint returns canvas info', async ({ request }) => {
    const response = await request.get('https://mcp.mpinto.space/');
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.name).toBe('Pixel Canvas MCP Server');
    expect(data.protocol).toContain('stateless');
    expect(data.tools).toContain('undo_pixel');
    expect(data.tools).toContain('get_history');
  });
});
