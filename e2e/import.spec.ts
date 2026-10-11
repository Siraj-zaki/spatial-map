import { test, expect } from '@playwright/test'
import { navigateTo, waitForBackendReady, selectTenantIfPrompted } from './test-utils'

test.describe('CSV import', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForBackendReady(page)
    await selectTenantIfPrompted(page)
  })

  test('imports a CSV file and creates bins', async ({ page }) => {
    const warehouseName = `E2E Import ${Date.now()}`

    // Create a warehouse.
    await page.getByRole('button', { name: 'Add warehouse' }).first().click()
    const dialog = page.locator('[role="dialog"]').filter({ hasText: /Add warehouse|Create warehouse|New warehouse/i }).first()
    await expect(dialog).toBeVisible()
    await dialog.locator('input').first().fill(warehouseName)
    await dialog.getByRole('button', { name: /Create|Save/i }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText(warehouseName).first()).toBeVisible()

    // Open the warehouse layout editor.
    const warehouseCard = page.getByTestId('warehouse-card').filter({ hasText: warehouseName }).first()
    await warehouseCard.click()
    await expect(page).toHaveURL(/\/create-grids/)
    await expect(page.getByText(warehouseName).first()).toBeVisible()

    // Open the Data-Link import wizard from the toolbar.
    await page.getByRole('button', { name: /Link external data/i }).click()
    const wizard = page.locator('[role="dialog"]').filter({ hasText: /Link external data/i }).first()
    await expect(wizard).toBeVisible()

    // Upload a CSV with externalCode and sku columns.
    const csvContent = 'externalCode,sku\nE2E-BIN-001,SKU-A\nE2E-BIN-002,SKU-B\n'
    const fileInput = wizard.locator('input[type="file"]').first()
    await fileInput.setInputFiles({
      name: 'e2e-bins.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csvContent),
    })

    // Wait for the match step (auto-detected externalCode column).
    await expect(wizard.getByText(/Match/i)).toBeVisible()
    await expect(wizard.getByText(/externalCode/i).first()).toBeVisible()

    // Advance through the wizard.
    await wizard.getByRole('button', { name: /Next/i }).click()

    // Map step — sku should be pre-mapped.
    await expect(wizard.getByText(/Mapping/i)).toBeVisible()
    await expect(wizard.getByText(/sku/i).first()).toBeVisible()
    await wizard.getByRole('button', { name: /Next/i }).click()

    // Preview step — both rows should be "will create".
    await expect(wizard.getByText(/Preview/i)).toBeVisible()
    await expect(wizard.getByText(/2/)).toBeVisible()

    // Commit the import.
    await wizard.getByRole('button', { name: /Commit import/i }).click()

    // Done step.
    await expect(wizard.getByText(/Done/i)).toBeVisible()
    await wizard.getByRole('button', { name: /Close/i }).click()
    await expect(wizard).not.toBeVisible()

    // Navigate to dashboard and verify bin count.
    await navigateTo(page, 'Warehouses')
    await expect(page.getByText(warehouseName).first()).toBeVisible()

    // The dashboard stat card shows total bins. We look for a count of 2 near the bin label.
    const card = page.getByTestId('warehouse-card').filter({ hasText: warehouseName }).first()
    await expect(card.getByText('2')).toBeVisible()
  })
})
