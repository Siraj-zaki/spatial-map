import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/components/theme-provider'
import { TenantProvider } from '@/components/tenant-provider'
import { installWorkspaceSwitchReloader } from '@/lib/workspace-switch'
// Inter Variable: one variable-weight WOFF2 file that covers every weight
// we render. Self-hosted via @fontsource-variable so nothing routes
// through Google Fonts (no third-party request, works offline). Tailwind
// picks it up as `font-sans` via the fontFamily.sans stack.
import '@fontsource-variable/inter'
import './i18n'
import './index.css'
import App from './App.tsx'
import { BootSplash } from '@/components/feedback/app-splash'

// Boot the "switching workspaces reloads every user-scoped store"
// subscription. Idempotent; the module tracks its own install state.
installWorkspaceSwitchReloader()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<BootSplash />}>
      <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
        <TenantProvider>
          <App />
        </TenantProvider>
      </ThemeProvider>
    </Suspense>
  </StrictMode>,
)
