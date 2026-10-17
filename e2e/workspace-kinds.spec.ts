import { test, expect } from './fixtures/test-base'
import path from 'path'

test.describe('F) Workspace kinds behavior', () => {
  let docsWsId = ''

  test.beforeAll(async ({ request }) => {
    // Create a docs workspace
    const res = await request.post('http://127.0.0.1:8000/api/workspaces', {
      data: { name: 'E2E Docs Workspace', description: 'Testing docs workspace UI', kind: 'docs' },
    })
    const ws = await res.json()
    docsWsId = ws.id

    // Ingest a text file
    const docFile = path.resolve(process.cwd(), 'e2e/fixtures/docs_folder/readme.md')
    // Or set status ready
  })

  test('Documents workspace hides code-specific tools (Impact, Trace, Flows)', async ({ page }) => {
    await page.goto(`/app/w/${docsWsId}`)

    // Documents workspace should NOT display Impact, Trace, or Flows buttons
    await expect(page.locator('button:has-text("Impact")')).not.toBeVisible()
    await expect(page.locator('button:has-text("Trace")')).not.toBeVisible()
    await expect(page.locator('button:has-text("Flows")')).not.toBeVisible()
  })
})
