/**
 * Profile API client. Reads / patches the current user's profile and uploads
 * an avatar image. All calls go through apiFetch so the Bearer token is
 * auto-stamped.
 */

import { API_V1_URL } from '@/config/api'
import { apiGet, apiPatch } from './api-client'
import { useAuthStore, type AuthUser } from './auth-store'

export interface ProfileUpdate {
  displayName: string
  bio: string
  location: string
  pronouns: string
  jobTitle: string
}

export async function getProfile(): Promise<AuthUser> {
  const user = await apiGet<AuthUser>('/profile')
  useAuthStore.getState().setUser(user)
  return user
}

export async function updateProfile(patch: ProfileUpdate): Promise<AuthUser> {
  const user = await apiPatch<AuthUser>('/profile', patch)
  useAuthStore.getState().setUser(user)
  return user
}

/**
 * Avatar upload uses multipart/form-data, which apiFetch's JSON path doesn't
 * handle, so we go through fetch directly — but still stamp the Bearer token
 * by hand. Returns the updated user.
 */
export async function uploadAvatar(file: File): Promise<AuthUser> {
  const token = useAuthStore.getState().token
  if (!token) throw new Error('not authenticated')

  const form = new FormData()
  form.append('file', file)

  const res = await fetch(`${API_V1_URL}/profile/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  const text = await res.text()
  let body: { data?: AuthUser; error?: string }
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`unexpected response (${res.status})`)
  }
  if (!res.ok || !body.data) {
    throw new Error(body.error ?? `upload failed (${res.status})`)
  }
  useAuthStore.getState().setUser(body.data)
  return body.data
}
