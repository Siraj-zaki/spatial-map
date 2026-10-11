import { request } from '@playwright/test'

/**
 * Global setup runs once before all E2E tests.
 *
 * It ensures the default tenant exists on the backend and records its id in
 * an environment variable so each test can target the same tenant.
 */

const apiURL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:8080'
const apiKey = process.env.PLAYWRIGHT_API_KEY ?? 'dev-api-key-change-in-production'
const TENANT_NAME = 'E2E Default'

async function apiFetch(path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${apiURL}/api/v1${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${opts.method ?? 'GET'} ${path} failed: ${res.status} ${text}`)
  }
  return res.json()
}

export default async function globalSetup() {
  // Health check the backend.
  let healthy = false
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${apiURL}/healthz`)
      if (res.ok) {
        healthy = true
        break
      }
    } catch {
      // Backend not up yet.
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!healthy) {
    throw new Error(`Backend at ${apiURL} is not reachable. Run 'npm run e2e:stack' first.`)
  }

  // Re-use an existing E2E tenant or create one.
  const { data: tenants } = await apiFetch('/tenants')
  let tenant = tenants?.find((t: { name: string }) => t.name === TENANT_NAME)
  if (!tenant) {
    const created = await apiFetch('/tenants', {
      method: 'POST',
      body: { name: TENANT_NAME, color: '#dc2626' },
    })
    tenant = created.data
  }

  if (!tenant?.id) {
    throw new Error('Could not determine E2E tenant id')
  }

  // Store it for tests and the SPA dev server.
  process.env.E2E_TENANT_ID = String(tenant.id)
  process.env.VITE_API_BASE_URL = apiURL
  process.env.VITE_API_KEY = apiKey
  process.env.PLAYWRIGHT_API_URL = apiURL
  process.env.PLAYWRIGHT_API_KEY = apiKey

  // Make sure the tenant is set as the current-tenant setting.
  await apiFetch('/settings/current-tenant', {
    method: 'PUT',
    body: { value: { tenantId: tenant.id } },
  })

  const ctx = await request.newContext()
  await ctx.dispose()
}
