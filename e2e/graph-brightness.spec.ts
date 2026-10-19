import { test, expect } from './fixtures/test-base'
import fs from 'fs'
import path from 'path'

test.describe('Graph brightness visual check', () => {
  test('fewer than 2% near-white pixels and mean luminance below 0.35 on ~750 nodes', async ({ page, allowConsoleError, allowFailedRequest }) => {
    allowConsoleError((text) => text.includes('WebSocket') || text.includes('ERR_CONNECTION') || text.includes('probe') || text.includes('Cannot reach'))
    allowFailedRequest(() => true)

    // Mock server health check so AppShell connects immediately
    await page.route('**/api/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          app: 'nexmind',
          status: 'ok',
          version: '1.1.0',
          llm: { provider: 'mock', available: true },
          capabilities: { local_paths: true },
        }),
      })
    })

    await page.route('**/api/workspaces', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'ws-brightness-750',
            name: '750 Nodes Workspace',
            kind: 'code',
            status: 'ready',
          },
        ]),
      })
    })

    await page.route('**/api/llm*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          provider: 'mock',
          model: null,
          available: true,
          available_providers: ['mock'],
        }),
      })
    })

    // Generate ~750 nodes with realistic types and cluster distributions
    const types = ['Source', 'Folder', 'File', 'Document', 'Section', 'Class', 'Function', 'Method', 'Module', 'Concept', 'Entity', 'Process']
    const clusters = [
      { id: 1, label: 'Core System', color: '#ff7c93' },
      { id: 2, label: 'Data Processing', color: '#5aa9ff' },
      { id: 3, label: 'Network Service', color: '#5cf2d6' },
      { id: 4, label: 'Auth & Security', color: '#ffc857' },
      { id: 5, label: 'User Interface', color: '#b79bff' },
      { id: 6, label: 'Storage Layer', color: '#ff9a4d' },
      { id: 7, label: 'Pipeline Engine', color: '#38e8ff' },
      { id: 8, label: 'Analytics Hub', color: '#ffd666' },
    ]

    const nodeCount = 750
    const nodes = []
    for (let i = 0; i < nodeCount; i++) {
      const type = types[i % types.length]
      const clusterId = (i % 8) + 1
      const theta = i * 2.39996 // golden angle
      const y = 1 - (i / (nodeCount - 1)) * 2
      const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y))
      const r = 90 + Math.cbrt((i + 1) / nodeCount) * 250
      nodes.push({
        id: `node-${i}`,
        label: `${type.toLowerCase()}_${i}`,
        type,
        score: Math.max(0.1, Number((1 - i / nodeCount).toFixed(2))),
        cluster: clusterId,
        x: r * radiusAtY * Math.cos(theta),
        y: r * y * 0.75,
        z: r * radiusAtY * Math.sin(theta),
      })
    }

    const links = []
    for (let i = 1; i < nodeCount; i++) {
      const targetIdx = Math.floor(Math.random() * i)
      links.push({
        id: `link-${i}`,
        source: `node-${i}`,
        target: `node-${targetIdx}`,
        type: i % 3 === 0 ? 'CONTAINS' : i % 3 === 1 ? 'CALLS' : 'IMPORTS',
      })
    }

    // Intercept backend API for this workspace
    await page.route('**/api/workspaces/ws-brightness-750', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'ws-brightness-750',
          name: '750 Nodes Workspace',
          description: 'Testing graph brightness with 750 nodes',
          kind: 'code',
          status: 'ready',
          source_count: 1,
        }),
      })
    })

    await page.route('**/api/workspaces/ws-brightness-750/threads*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.route('**/api/workspaces/ws-brightness-750/sources*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.route('**/api/workspaces/ws-brightness-750/insights*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.route('**/api/workspaces/ws-brightness-750/processes*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    await page.route('**/api/workspaces/ws-brightness-750/graph*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes,
          links,
          clusters,
          total_nodes: nodeCount,
          truncated: false,
          legend: {
            node_colors: {},
            edge_colors: {},
          },
        }),
      })
    })

    // Navigate to the test workspace
    await page.goto('/app/w/ws-brightness-750')

    // Wait for the canvas to be rendered and visible
    const canvas = page.locator('canvas').first()
    await expect(canvas).toBeVisible({ timeout: 25000 })

    // Give the engine time to settle relaxation, camera framing, and render frames
    await page.waitForTimeout(2000)

    // Ensure artifacts directory exists
    const artifactsDir = path.resolve(process.cwd(), 'e2e/artifacts')
    if (!fs.existsSync(artifactsDir)) {
      fs.mkdirSync(artifactsDir, { recursive: true })
    }
    const screenshotPath = path.join(artifactsDir, 'graph-brightness.png')

    // Capture screenshot of the canvas
    await canvas.screenshot({ path: screenshotPath })
    expect(fs.existsSync(screenshotPath)).toBe(true)

    // Calculate near-white pixel fraction and mean luminance from the screenshot
    const imageBase64 = fs.readFileSync(screenshotPath).toString('base64')
    const stats = await page.evaluate(async (b64) => {
      return new Promise<{ nearWhitePct: number; meanLuminance: number; totalPixels: number }>((resolve) => {
        const img = new Image()
        img.onload = () => {
          const c = document.createElement('canvas')
          c.width = img.width
          c.height = img.height
          const ctx = c.getContext('2d')!
          ctx.drawImage(img, 0, 0)
          const data = ctx.getImageData(0, 0, img.width, img.height).data
          let nearWhiteCount = 0
          let totalLuminance = 0
          const totalPixels = img.width * img.height
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i]
            const g = data[i + 1]
            const b = data[i + 2]
            if (r > 235 && g > 235 && b > 235) {
              nearWhiteCount++
            }
            const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
            totalLuminance += lum
          }
          resolve({
            nearWhitePct: nearWhiteCount / totalPixels,
            meanLuminance: totalLuminance / totalPixels,
            totalPixels,
          })
        }
        img.src = `data:image/png;base64,${b64}`
      })
    }, imageBase64)

    // Assert: fewer than 2% of canvas pixels are near-white (all RGB channels > 235)
    expect(
      stats.nearWhitePct,
      `Expected fewer than 2% near-white pixels, got ${(stats.nearWhitePct * 100).toFixed(2)}%`
    ).toBeLessThan(0.02)

    // Assert: mean luminance of the canvas is below 0.35
    expect(
      stats.meanLuminance,
      `Expected mean luminance below 0.35, got ${stats.meanLuminance.toFixed(4)}`
    ).toBeLessThan(0.35)
  })
})
