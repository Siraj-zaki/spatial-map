/**
 * /tables/new — create a thing-type table.
 *
 * Two steps in one page (SchemaBuilder in create mode): name + kind, then
 * the fields — seeded with the kind's standard columns — with a live
 * preview of the record body the table's API will accept. The backend
 * mints a "default" API key on create; the user copies it later from the
 * detail page's API & access tab. On success we land on `/tables/:id`.
 *
 * Owners/admins only (the API refuses others); everyone else gets an
 * explanation instead of a form that would fail on submit.
 */

import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageContainer, PageHero, rise } from '@/components/page-shell'
import { EmptyState } from '@/components/empty-state'
import { SchemaBuilder } from '@/components/data-link/schema-builder'
import { useWorkspaceRole } from '@/hooks/useWorkspaceRole'
import { queryCache } from '@/lib/useApiQuery'
import { toast } from '@/lib/toast-store'

export default function TableNewPage() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const canManage = useWorkspaceRole().can('data.manage')

  const back = (
    <Link
      to="/tables"
      className="inline-flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
      {t('tables.detail.back', { defaultValue: 'All tables' })}
    </Link>
  )

  return (
    <PageContainer className="gap-6">
      <div {...rise(0)}>{back}</div>
      <div {...rise(1)}>
        <PageHero
          title={t('tables.create.pageTitle', { defaultValue: 'Create new table' })}
          description={t('tables.create.pageSubtitleV2', {
            defaultValue: 'Name it, pick the kind of thing each record describes, and choose its fields. You can change the fields later.',
          })}
        />
      </div>
      <div {...rise(2)}>
        {canManage ? (
          <SchemaBuilder
            existing={null}
            onCancel={() => navigate('/tables')}
            onDone={(createdId) => {
              queryCache.invalidate('tables')
              toast.success(t('tables.create.created', { defaultValue: 'Table created' }), {
                description: t('tables.create.createdBody', { defaultValue: 'Add your first record, or copy the API key from API & access.' }),
              })
              navigate(createdId !== undefined ? `/tables/${createdId}` : '/tables')
            }}
          />
        ) : (
          <EmptyState
            icon={Lock}
            title={t('tables.create.noPermissionTitle', { defaultValue: 'Only owners and admins can create tables' })}
            description={t('tables.create.noPermissionBody', { defaultValue: 'Ask a workspace owner or admin to create it. You can still browse and edit records in existing tables.' })}
            action={
              <Button asChild variant="outline">
                <Link to="/tables">{t('tables.detail.back', { defaultValue: 'All tables' })}</Link>
              </Button>
            }
          />
        )}
      </div>
    </PageContainer>
  )
}
