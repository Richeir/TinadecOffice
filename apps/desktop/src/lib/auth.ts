/**
 * Logto account login for the Desktop shell.
 *
 * The session token never reaches the renderer — the Electron main process owns
 * it (mirroring how `X-Tinadec-Host-Control` is kept out of the page). This
 * module only asks the main process to open the login window and, on success,
 * syncs the returned identity into the local profile's avatar + nickname slots.
 */
import { ref } from 'vue'
import { setAvatar, setNickname } from './userProfile'

const loggedIn = ref(false)

/** Open the Logto login window and sync the returned identity into the local profile. */
async function login(): Promise<boolean> {
  const bridge = window.tinadec
  if (!bridge?.openLogin) return false
  const identity = await bridge.openLogin()
  if (!identity) return false
  setNickname(identity.nickname)
  setAvatar(identity.avatar_url)
  loggedIn.value = true
  return true
}

/** Drop the login session. Local avatar/nickname stay as the last known identity. */
async function logout(): Promise<void> {
  const bridge = window.tinadec
  if (!bridge?.logout) return
  await bridge.logout()
  loggedIn.value = false
}

/**
 * Write nickname / avatar to the Logto account and adopt what Logto reports back.
 * Throws when the write fails, so the caller can surface the reason; the local
 * profile only changes once the account does.
 */
async function updateProfile(patch: { nickname?: string; avatarUrl?: string }): Promise<void> {
  const bridge = window.tinadec
  if (!bridge?.updateProfile) throw new Error('Profile changes require the desktop shell.')
  const identity = await bridge.updateProfile(patch)
  setNickname(identity.nickname)
  setAvatar(identity.avatar_url)
  loggedIn.value = true
}

/** Reconcile against the main process (e.g. after an SPA reload with a live session). */
async function refreshAuthState(): Promise<void> {
  const bridge = window.tinadec
  if (!bridge?.getAuthState) { loggedIn.value = false; return }
  const state = await bridge.getAuthState()
  if (state.loggedIn) {
    setNickname(state.nickname)
    setAvatar(state.avatar_url)
  }
  loggedIn.value = state.loggedIn
}

export const auth = {
  loggedIn,
  login,
  logout,
  updateProfile,
  refreshAuthState,
}