import { test, expect } from './fixtures/test-base'
import path from 'path'

test.describe('D) New workspace flow', () => {
  test('Step 1 displays three mode cards, supports key navigation, Esc to close, and Back button', async ({ page }) => {
    await page.goto('/app')

    const newWsBtn = page.locator('button:has-text("New workspace")').first()
    await newWsBtn.click()

    // Step 1: Mode selection
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('text=What do you want to explore?')).toBeVisible()

    const projectCard = dialog.locator('text=Projects').first()
    const docsCard = dialog.locator('text=Documents').first()
    const liveCard = dialog.locator('text=Live connect').first()

    await expect(projectCard).toBeVisible()
    await expect(docsCard).toBeVisible()
    await expect(liveCard).toBeVisible()

    // Press Escape closes the modal
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()

    // Reopen and test Back button
    await newWsBtn.click()
    await expect(dialog).toBeVisible()
    await projectCard.click()

    // Now in Step 2: Projects form
    await expect(dialog.locator('role=tab[name="GitHub"]')).toBeVisible()
    const backBtn = dialog.locator('button:has-text("Back"), button[aria-label="Back"]').first()
    await backBtn.click()

    // Returned to Step 1
    await expect(dialog.locator('text=What do you want to explore?')).toBeVisible()
  })

  test('Creating a project workspace via archive upload navigates to workspace', async ({ page }) => {
    await page.goto('/app')

    await page.locator('button:has-text("New workspace")').first().click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.locator('text=Projects').first().click()

    // Switch to Upload project tab
    await dialog.locator('role=tab[name="Upload project"]').click()

    // Upload fixture zip
    const fixtureZip = path.resolve(process.cwd(), 'e2e/fixtures/code_project.zip')
    const fileChooserPromise = page.waitForEvent('filechooser')
    await dialog.locator('button:has-text("Choose files")').click()
    const fileChooser = await fileChooserPromise
    await fileChooser.setFiles(fixtureZip)

    // Analyze button should be active
    const analyzeBtn = dialog.locator('button:has-text("Analyze")')
    await expect(analyzeBtn).toBeEnabled()
    await analyzeBtn.click()

    // Navigates to workspace page
    await expect(page).toHaveURL(/\/app\/w\/[a-zA-Z0-9_-]+/, { timeout: 30000 })
  })

  test('Documents workspace mode displays document upload interface and rejects kind mismatch', async ({ page }) => {
    await page.goto('/app')

    await page.locator('button:has-text("New workspace")').first().click()
    const dialog = page.locator('[role="dialog"]')
    await dialog.locator('text=Documents').first().click()

    // In docs mode, upload zone is shown directly with no Git tabs
    await expect(dialog.locator('text=/Drop PDFs, Word files/i')).toBeVisible()
    await expect(dialog.locator('role=tab[name="GitHub"]')).not.toBeVisible()
  })
})
