import { createApp, h, vaporInteropPlugin } from '/src/lib/vue-shim.ts'
import i18n from '/src/i18n.ts'
import '/src/styles.css'
import AppSidebar from '/src/components/AppSidebar.vue'
import { setNickname } from '/src/lib/userProfile.ts'
import { useTheme } from '/src/composables/useTheme.ts'

useTheme().setTheme('dark')
document.body.style.background = 'var(--bg-primary)'
document.body.style.color = 'var(--text-primary)'
setNickname(new URLSearchParams(location.search).get('name') || '风眠')

const project = { id: 'p-1', name: 'TinadecOffice', path: 'C:/git/agent/TinadecOffice', created_at: '2026-10-20T00:00:00Z' }
const sessions = [
  { id: 's-1', project_id: 'p-1', title: '侧边栏昵称验收', status: 'ready', permission_mode: 'default', settings_revision: 0, created_at: '2026-10-20T00:00:00Z', updated_at: '2026-10-20T00:00:00Z' },
]

// Two rails: the expanded column whose width is driven from the outside, and the
// collapsed icon rail, so both footer layouts are on one screenshot.
const app = createApp({
  render: () => h('main', { style: 'display:flex;align-items:flex-start;gap:16px;height:100vh;padding:8px' }, [
    h('div', { id: 'rail', style: 'width:280px;height:640px;display:flex;flex-direction:column;background:var(--surface-raised);border:1px solid var(--border-muted);border-radius:12px;overflow:hidden;transition:width .2s' }, [
      h(AppSidebar, { projects: [project], sessions, selectedProjectId: 'p-1', selectedSessionId: 's-1', busy: false }),
    ]),
    h('div', { id: 'collapsed-rail', style: 'width:52px;height:640px;display:flex;flex-direction:column;background:var(--surface-raised);border:1px solid var(--border-muted);border-radius:12px;overflow:hidden' }, [
      h(AppSidebar, { projects: [project], sessions, selectedProjectId: 'p-1', selectedSessionId: 's-1', busy: false, collapsed: true }),
    ]),
  ]),
})
app.use(vaporInteropPlugin).use(i18n).mount('#app')
