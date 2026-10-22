// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { recentSessionRows, recentWorkspaceSessions, revealWorkspace, useWorkspaceList, workspaceListStorageKey } from './useWorkspaceList'
import type { SessionDto } from '@/api'
describe('workspace list persistence', () => {
  beforeEach(() => localStorage.clear())
  it('reveals a created workspace without resetting manual order or other groups', () => {
    let list!: ReturnType<typeof useWorkspaceList>
    const wrapper = mount(defineComponent({ setup() { list = useWorkspaceList(); return () => null } }))
    list.reconcile(['one', 'two']); list.state.value.collapsed = true
    list.toggle('one', 'collapsedKeys'); list.toggle('two', 'collapsedKeys')
    revealWorkspace('one')
    expect(list.state.value.collapsed).toBe(false)
    expect(list.state.value.collapsedKeys).toEqual(['two'])
    expect(list.state.value.order).toEqual(['one', 'two']); wrapper.unmount()
  })
  it('keeps five recent rows and the active older conversation', () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({ id: `${index}`, storage_id: 'one', updated_at: new Date(index * 1000).toISOString() } as SessionDto))
    expect(recentWorkspaceSessions(rows, 'one::0').map(row => row.id)).toEqual(['8', '7', '6', '5', '4', '0'])
    expect(recentWorkspaceSessions(rows, null, true)).toHaveLength(9)
  })
  it('ranks the recent list newest first across workspaces and caps it', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: `${index}`, updated_at: new Date(index * 1000).toISOString() } as SessionDto))
    expect(recentSessionRows(rows, 8).map(row => row.id)).toEqual(['9', '8', '7', '6', '5', '4', '3', '2'])
    // Ties fall back to the id, so the order never depends on the order the groups were walked.
    const ties = [{ id: 'b', updated_at: '2026-01-01T00:00:00Z' }, { id: 'a', updated_at: '2026-01-01T00:00:00Z' }] as SessionDto[]
    expect(recentSessionRows(ties, 8).map(row => row.id)).toEqual(['a', 'b'])
  })
  it('retains manual order and state across refresh and remount', () => {
    let list!: ReturnType<typeof useWorkspaceList>
    const component = defineComponent({ setup() { list = useWorkspaceList(); return () => null } })
    let wrapper = mount(component)
    list.reconcile(['a::p', 'b::p']); list.step('b::p', -1); list.toggle('a::p', 'collapsedKeys'); list.toggle('b::p', 'allKeys')
    list.reconcile(['a::p', 'b::p']); expect(list.state.value.order).toEqual(['b::p', 'a::p'])
    list.reconcile(['a::p', 'c::p', 'b::p']); expect(list.state.value.order).toEqual(['c::p', 'b::p', 'a::p'])
    wrapper.unmount(); wrapper = mount(component)
    expect(list.state.value.collapsedKeys).toEqual(['a::p']); expect(list.state.value.allKeys).toEqual(['b::p'])
    expect(JSON.parse(localStorage.getItem(workspaceListStorageKey)!)).toEqual(list.state.value); wrapper.unmount()
  })
  it('keeps conversation groups visible by default and remembers hiding them', () => {
    let list!: ReturnType<typeof useWorkspaceList>
    const component = defineComponent({ setup() { list = useWorkspaceList(); return () => null } })
    let wrapper = mount(component)
    expect(list.state.value.projectConversations).toBe(true)
    expect(list.state.value.freeConversation).toBe(true)
    expect(list.state.value.allActivity).toBe(false)
    expect(list.state.value.projectActivity).toBe(false)
    list.setProjectConversations(false)
    list.setFreeConversation(false)
    list.setAllActivity(true)
    list.setProjectActivity(true)
    const saved = JSON.parse(localStorage.getItem(workspaceListStorageKey)!)
    expect(saved.projectConversations).toBe(false)
    expect(saved.freeConversation).toBe(false)
    expect(saved.allActivity).toBe(true)
    expect(saved.projectActivity).toBe(true)
    wrapper.unmount(); wrapper = mount(component)
    expect(list.state.value.projectConversations).toBe(false)
    expect(list.state.value.freeConversation).toBe(false)
    expect(list.state.value.allActivity).toBe(true)
    expect(list.state.value.projectActivity).toBe(true)

    // Older records predate both options; they must keep rendering every group.
    localStorage.setItem(workspaceListStorageKey, JSON.stringify({ collapsed: false, collapsedKeys: [], allKeys: [], order: [], recent: false }))
    wrapper.unmount(); wrapper = mount(component)
    expect(list.state.value.projectConversations).toBe(true)
    expect(list.state.value.freeConversation).toBe(true)
    wrapper.unmount()
  })

  it('remembers the block order the options menu was dragged into', () => {
    let list!: ReturnType<typeof useWorkspaceList>
    const component = defineComponent({ setup() { list = useWorkspaceList(); return () => null } })
    let wrapper = mount(component)
    expect(list.state.value.sectionOrder).toEqual(['recent', 'activity', 'free', 'projects', 'allActivity', 'projectActivity'])
    list.moveSection('free', 'recent', false)
    expect(list.state.value.sectionOrder).toEqual(['free', 'recent', 'activity', 'projects', 'allActivity', 'projectActivity'])
    wrapper.unmount(); wrapper = mount(component)
    expect(list.state.value.sectionOrder).toEqual(['free', 'recent', 'activity', 'projects', 'allActivity', 'projectActivity'])
    list.moveSection('free', 'projects', true)
    expect(list.state.value.sectionOrder).toEqual(['recent', 'activity', 'projects', 'free', 'allActivity', 'projectActivity'])
    list.stepSection('free', -1)
    expect(list.state.value.sectionOrder).toEqual(['recent', 'activity', 'free', 'projects', 'allActivity', 'projectActivity'])

    // A record written before a block existed still renders it: unknown ids are dropped and the
    // missing ones are appended in their declared order instead of vanishing from the sidebar.
    localStorage.setItem(workspaceListStorageKey, JSON.stringify({ collapsed: false, collapsedKeys: [], allKeys: [], order: [], recent: false, sectionOrder: ['projects', 'nope', 'free'] }))
    wrapper.unmount(); wrapper = mount(component)
    expect(list.state.value.sectionOrder).toEqual(['projects', 'free', 'recent', 'activity', 'allActivity', 'projectActivity'])
    wrapper.unmount()
  })

  it('moves a workspace after the drop target when requested and keeps free conversation ordered', () => {
    let list!: ReturnType<typeof useWorkspaceList>
    const wrapper = mount(defineComponent({ setup() { list = useWorkspaceList(); return () => null } }))
    list.reconcile(['user::free', 'a::p', 'b::p', 'c::p'])
    list.move('user::free', 'b::p', true)
    expect(list.state.value.order).toEqual(['a::p', 'b::p', 'user::free', 'c::p'])
    list.move('c::p', 'a::p', false)
    expect(list.state.value.order).toEqual(['c::p', 'a::p', 'b::p', 'user::free'])
    // reconcile must preserve the user's order and only append genuinely new groups
    list.reconcile(['user::free', 'a::p', 'b::p', 'c::p'])
    expect(list.state.value.order).toEqual(['c::p', 'a::p', 'b::p', 'user::free'])
    list.reconcile(['user::free', 'a::p', 'b::p', 'c::p', 'd::p'])
    expect(list.state.value.order).toEqual(['c::p', 'a::p', 'b::p', 'user::free', 'd::p'])
    wrapper.unmount()
  })
})
