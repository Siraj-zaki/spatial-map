import { test, expect } from '@playwright/test'
import { navigateTo, waitForBackendReady } from './test-utils'

test.describe('Integrations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForBackendReady(page)
    await navigateTo(page, 'Integrations')
  })

  test('can create and delete a REST data source', async ({ page }) => {
    const sourceName = `E2E REST ${Date.now()}`

    await page.getByRole('button', { name: 'Add REST source' }).click()
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Add REST source|Edit source/i }).first()
    await expect(dialog).toBeVisible()

    const inputs = dialog.locator('input')
    await inputs.first().fill(sourceName)
    await inputs.nth(1).fill('http://example.com/api')
    await dialog.getByRole('button', { name: /Save source|Save changes|Register/i }).click()

    await expect(dialog).not.toBeVisible()
    await expect(page.getByText(sourceName).first()).toBeVisible()

    // The integrations card uses a browser `confirm()` for deletion.
    page.on('dialog', (dialog) => dialog.accept())

    // Delete it.
    const row = page.locator('.rounded-xl', { hasText: sourceName }).first()
    await row.getByRole('button', { name: /Delete/i }).click()
    await expect(page.getByText(sourceName)).not.toBeVisible()
  })

  test('tenant switcher shows the E2E default tenant', async ({ page }) => {
    await page.getByTitle('Switch tenant').first().click()
    await expect(page.getByRole('menuitem', { name: 'E2E Default' })).toBeVisible()
  })
})
