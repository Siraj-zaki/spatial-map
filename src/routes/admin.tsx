/**
 * /admin — platform-admin overview (signups, workspaces,
 * all users) across the whole deployment. Moved off /dashboard in the
 * 2026-09 redesign: the dashboard is about the workspace you're in, this
 * is about the instance. Visible only to `isPlatformAdmin` users; anyone
 * else is sent back to the dashboard (the API enforces it regardless).
 */

import { Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { AdminOverviewChapter } from '@/components/admin-overview-chapter'
import { PageContainer, PageHero } from '@/components/page-shell'
import { useAuthStore } from '@/lib/auth-store'

export default function AdminPage() {
  const { t } = useTranslation()
  const isAdmin = useAuthStore((s) => Boolean(s.user?.isPlatformAdmin))
  if (!isAdmin) return <Navigate to="/dashboard" replace />
  return (
    <PageContainer>
      <PageHero
        title={t('admin.pageTitle', { defaultValue: 'Platform admin' })}
        description={t('admin.pageSubtitle', {
          defaultValue: 'Signups and workspaces across this whole deployment. Only platform admins see this page.',
        })}
      />
      <AdminOverviewChapter />
    </PageContainer>
  )
}
