import { test, expect } from '@playwright/test'
import { createWarehouse, navigateTo, waitForBackendReady } from './test-utils'

test.describe('Warehouse lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForBackendReady(page)
  })

  test('creates a warehouse and sees it on the dashboard', async ({ page }) => {
    const warehouseName = `E2E Warehouse ${Date.now()}`

    page.on('console', (msg) => {
      const text = msg.text()
      if (text.includes('Objects are not valid as a React child')) {
        throw new Error(`React child error in browser: ${text}`)
      }
    })
    page.on('pageerror', (err) => {
      throw new Error(`Browser page error: ${err.message}\n${err.stack ?? ''}`)
    })

    await createWarehouse(page, warehouseName)
    await expect(page.getByText(warehouseName).first()).toBeVisible()

    // Navigate away and back to confirm persistence through the backend.
    await navigateTo(page, 'Layout Editor')
    await navigateTo(page, 'Warehouses')
    await expect(page.getByText(warehouseName).first()).toBeVisible()
  })

  test('deletes a warehouse from the dashboard', async ({ page }) => {
    const warehouseName = `E2E Delete Me ${Date.now()}`

    await createWarehouse(page, warehouseName)
    await expect(page.getByText(warehouseName).first()).toBeVisible()

    // Find the warehouse card and click its delete action.
    const card = page.getByTestId('warehouse-card').filter({ hasText: warehouseName }).first()
    await card.scrollIntoViewIfNeeded()
    await card.hover()
    await card.getByRole('button', { name: /Delete/i }).click()

    const confirm = page.locator('[role="alertdialog"], [role="dialog"]')
      .filter({ hasText: /Delete|Confirm/i }).first()
    await confirm.getByRole('button', { name: /Delete|Confirm/i }).click()

    await expect(page.getByTestId('warehouse-card').filter({ hasText: warehouseName })).not.toBeVisible()
  })
})
