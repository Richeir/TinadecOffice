import { describe, expect, it } from 'vitest'
import { PROFILE_NAME_MIN_GAP, profileNameFits, type ProfileFooterMetrics } from './profileNameFit'

/** A 260px nav column in its resting state: 12px side padding, 8px column gap. */
const ROW: ProfileFooterMetrics = {
  footerWidth: 260,
  padding: 24,
  gap: 8,
  actionsWidth: 88,
  avatarSize: 20,
  buttonPadding: 3,
  nameGap: 6,
  nameWidth: 48,
}

describe('profileNameFits', () => {
  it('shows the name when the row holds it whole with room to spare', () => {
    // 24 + 6 + 20 + 6 + 48 + 10 + 8 + 88 = 210 of 260.
    expect(profileNameFits(ROW)).toBe(true)
  })

  it('drops the name once the row is too narrow for the whole word', () => {
    expect(profileNameFits({ ...ROW, footerWidth: 200 })).toBe(false)
  })

  it('reserves clear space before the actions instead of touching them', () => {
    // Exactly the geometry of a fit, minus one pixel of breathing room.
    const snug = 24 + 6 + 20 + 6 + 48 + 8 + 88
    expect(profileNameFits({ ...ROW, footerWidth: snug })).toBe(false)
    expect(profileNameFits({ ...ROW, footerWidth: snug + PROFILE_NAME_MIN_GAP })).toBe(true)
  })

  it('treats a long nickname like a narrow row: it is the arithmetic, not a breakpoint', () => {
    expect(profileNameFits({ ...ROW, nameWidth: 120 })).toBe(false)
    expect(profileNameFits({ ...ROW, footerWidth: 340, nameWidth: 120 })).toBe(true)
  })

  it('never claims a fit before the row has been laid out', () => {
    expect(profileNameFits({ ...ROW, footerWidth: 0 })).toBe(false)
    expect(profileNameFits({ ...ROW, nameWidth: 0 })).toBe(false)
  })

  it('honours a caller-supplied minimum gap', () => {
    const snug = 24 + 6 + 20 + 6 + 48 + 8 + 88
    expect(profileNameFits({ ...ROW, footerWidth: snug + 4, minGap: 4 })).toBe(true)
    expect(profileNameFits({ ...ROW, footerWidth: snug + 4, minGap: 12 })).toBe(false)
  })
})
