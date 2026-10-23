// @vitest-environment happy-dom
/**
 * PersonalSection identity-row regression tests (2026-10-04 UI revision).
 *
 * These pin the four things the reference layout asked for:
 * - the work identity is one grouped, icon-bearing chip beside the nickname —
 *   not a standalone "set roles" button and not one badge per role;
 * - the unset state reads "no work roles set" and is still the click target;
 * - the chip opens the role picker, whose chips each carry their own icon and
 *   which previews the joined selection;
 * - the bio renders under the nickname and is editable from the profile dialog.
 *
 * `t` returns the key (same mock as AppearanceSection.test.ts), so assertions
 * read as `settings.personalRole_pm` rather than a translated string.
 */
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PersonalSection from './PersonalSection.vue'
import { auth } from '@/lib/auth'
import { WORK_ROLES, setBio, setCustomRole, setNickname, setRoles, userProfile } from '@/lib/userProfile'

// `locale` is not decoration: the share card formats numbers and the date with
// it, so the mock has to carry the same shape the real composable does.
vi.mock('vue-i18n', async (importOriginal) => ({ ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: { value: 'zh-CN' } }),
}))

vi.mock('@/composables/useNotifications', () => ({
  useNotifications: () => ({
    notify: { success: vi.fn(), error: vi.fn() },
    status: { error: vi.fn() },
    dismissByKey: vi.fn(),
    // The account-write confirmation the save path raises once the nickname changes.
    confirm: vi.fn(async () => true),
  }),
}))

vi.mock('@/api', () => ({
  api: { listModelInvocations: vi.fn(async () => ({ items: [], next_cursor: null })) },
}))

// Everything these dialogs render is classic, so the section mounts for real
// here — no ui stubs. That is a constraint, not a coincidence: `UiLabel` is a
// Vapor SFC, and vitest loads the CJS classic runtime beside the ESM Vapor
// runtime, so a Vapor child throws `simpleSetCurrentInstance is not a function`
// (the dialogs therefore label their fields with `.personal-field-label`).

function mountSection() {
  // Both dialogs sit behind `<Transition>`; test-utils stubs it by default and
  // renders nothing at all. Same fix as RowContextMenu.test.ts: keep it real.
  return mount(PersonalSection, { global: { stubs: { transition: false } } })
}

beforeEach(() => {
  localStorage.clear()
  setNickname('')
  setBio('')
  setRoles([])
  setCustomRole('')
})

describe('PersonalSection work identity', () => {

  it('reads as an actionable placeholder while no role is set', async () => {
    const wrapper = mountSection()
    const chip = wrapper.find('.personal-identity')

    expect(chip.classes()).toContain('is-empty')
    expect(chip.text()).toContain('settings.personalRolesEmpty')

    // The placeholder is the entry to the role picker, like the filled chip.
    await chip.trigger('click')
    expect(wrapper.find('.personal-role-chips').exists()).toBe(true)
  })

  it('opens the role picker, icon per role, previewing the joined draft', async () => {
    setRoles(['pm'])
    const wrapper = mountSection()
    await wrapper.find('.personal-identity').trigger('click')

    const chips = wrapper.findAll('.personal-role-chip')
    expect(chips).toHaveLength(WORK_ROLES.length)
    for (const chip of chips) expect(chip.find('svg').exists()).toBe(true)

    // The draft starts from what is stored, so the preview repeats it.
    const preview = wrapper.find('.personal-role-preview')
    expect(preview.text()).toContain('settings.personalRolesPreview')
    expect(preview.text()).toContain('settings.personalRole_pm')
    expect(preview.classes()).not.toContain('is-empty')

    // Selecting a second role joins it into the same reading.
    await chips[0]!.trigger('click')
    expect(preview.text()).toContain('settings.personalRoleSeparator')
    expect(wrapper.find('.personal-role-chip.selected svg').exists()).toBe(true)
  })

  it('saves the picked roles through the store', async () => {
    const wrapper = mountSection()
    await wrapper.find('.personal-identity').trigger('click')
    await wrapper.findAll('.personal-role-chip')[0]!.trigger('click')
    const save = wrapper.findAll('.gateway-config-actions button')
    await save[save.length - 1]!.trigger('click')

    expect(userProfile.roles).toEqual([WORK_ROLES[0]])
  })
})

describe('PersonalSection custom role', () => {
  it('asks for the user\u2019s own words only while "other" is picked', async () => {
    const wrapper = mountSection()
    await wrapper.find('.personal-identity').trigger('click')

    // Nothing to type into until the escape-hatch role is selected.
    expect(wrapper.find('#personal-custom-role').exists()).toBe(false)

    const other = wrapper.findAll('.personal-role-chip')[WORK_ROLES.indexOf('other')]!
    await other.trigger('click')
    expect(wrapper.find('#personal-custom-role').exists()).toBe(true)
    expect(wrapper.find('.personal-role-custom').text()).toContain('settings.personalRolesCustomLabel')

    // And it goes away again when the role is dropped.
    await other.trigger('click')
    expect(wrapper.find('#personal-custom-role').exists()).toBe(false)
  })

  it('stands in for the generic label on the chip once saved', async () => {
    const wrapper = mountSection()
    await wrapper.find('.personal-identity').trigger('click')
    await wrapper.findAll('.personal-role-chip')[WORK_ROLES.indexOf('other')]!.trigger('click')

    const input = wrapper.find('#personal-custom-role')
    expect((input.element as HTMLInputElement).maxLength).toBe(24)
    await input.setValue('智能体架构师')

    // The preview reads the draft with the custom words replacing "other".
    const preview = wrapper.find('.personal-role-preview')
    expect(preview.text()).toContain('智能体架构师')
    expect(preview.text()).not.toContain('settings.personalRole_other')

    const save = wrapper.findAll('.gateway-config-actions button')
    await save[save.length - 1]!.trigger('click')

    expect(userProfile.roles).toEqual(['other'])
    expect(userProfile.customRole).toBe('智能体架构师')
    // The hero chip replaces the generic word too.
    const chip = wrapper.find('.personal-identity')
    expect(chip.text()).toContain('智能体架构师')
    expect(chip.text()).not.toContain('settings.personalRole_other')
  })

  it('falls back to "other" when the custom field is left empty', async () => {
    setRoles(['pm', 'other'])
    const wrapper = mountSection()
    await wrapper.find('.personal-identity').trigger('click')
    await wrapper.find('#personal-custom-role').setValue('   ')
    const save = wrapper.findAll('.gateway-config-actions button')
    await save[save.length - 1]!.trigger('click')

    expect(userProfile.customRole).toBe('')
    const chip = wrapper.find('.personal-identity')
    expect(chip.text()).toContain('settings.personalRole_other')
    expect(chip.text()).toContain('settings.personalRole_pm')
    expect(chip.text()).toContain('settings.personalRoleSeparator')
  })

  it('retires a stale custom label when "other" is deselected', async () => {
    setRoles(['other'])
    setCustomRole('智能体架构师')
    const wrapper = mountSection()
    await wrapper.find('.personal-identity').trigger('click')
    await wrapper.findAll('.personal-role-chip')[WORK_ROLES.indexOf('other')]!.trigger('click')
    const save = wrapper.findAll('.gateway-config-actions button')
    await save[save.length - 1]!.trigger('click')

    expect(userProfile.roles).toEqual([])
    expect(userProfile.customRole).toBe('')
    expect(wrapper.find('.personal-identity').text()).toContain('settings.personalRolesEmpty')
  })
})

describe('PersonalSection bio', () => {
  /**
   * Since Logto owns the identity (1eb448b4), the hero nickname and the profile
   * dialog only exist for a signed-in account: signed out, the hero reads
   * "not logged in" and the edit entry goes to login instead. These cases
   * therefore sign in through the desktop bridge the way the main process would.
   */
  function signIn(nickname = 'wwiinnddy'): void {
    Object.defineProperty(window, 'tinadec', {
      configurable: true,
      value: {
        getAuthState: vi.fn(async () => ({ loggedIn: true, nickname, avatar_url: '' })),
        // Logto echoes what was written; the local profile adopts the reply.
        updateProfile: vi.fn(async (patch: { nickname?: string }) => ({ nickname: patch.nickname ?? nickname, avatar_url: '' })),
        openLogin: vi.fn(async () => null),
      },
    })
  }

  afterEach(() => {
    delete (window as unknown as { tinadec?: unknown }).tinadec
    auth.loggedIn.value = false
  })

  it('renders the bio under the nickname', async () => {
    setNickname('wwiinnddy')
    setBio('try anything')
    signIn()
    const wrapper = mountSection()
    await flushPromises()

    const bio = wrapper.find('.personal-hero-bio')
    expect(bio.text()).toBe('try anything')
    expect(bio.classes()).not.toContain('is-empty')
    expect(wrapper.find('.personal-hero-info').text()).toContain('wwiinnddy')
  })

  it('shows the placeholder instead of an empty line', () => {
    const wrapper = mountSection()
    const bio = wrapper.find('.personal-hero-bio')

    expect(bio.text()).toBe('settings.personalBioEmpty')
    expect(bio.classes()).toContain('is-empty')
  })

  it('writes nickname and bio from the profile dialog', async () => {
    signIn()
    const wrapper = mountSection()
    await flushPromises()
    // The edit entry, not the login/logout toggle beside it.
    await wrapper.findAll('.personal-hero-actions button')[1]!.trigger('click')

    const nickname = wrapper.find('#personal-nickname')
    const bio = wrapper.find('#personal-bio')
    expect(nickname.exists()).toBe(true)
    expect(bio.exists()).toBe(true)
    // The dialog states the stored limit instead of silently truncating.
    expect((bio.element as HTMLTextAreaElement).maxLength).toBe(80)

    await nickname.setValue('wwiinnddy')
    await bio.setValue('try anything')
    const actions = wrapper.findAll('.gateway-config-actions button')
    await actions[actions.length - 1]!.trigger('click')
    await flushPromises()

    expect(userProfile.nickname).toBe('wwiinnddy')
    expect(userProfile.bio).toBe('try anything')
  })
})
