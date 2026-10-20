/**
 * Whether the sidebar footer can show the nickname beside the portrait.
 *
 * The footer is one row: `[portrait][nickname] ........ [view][settings][collapse]`.
 * A narrow column would slice the nickname in half, and an ellipsized name in the
 * identity slot reads as a bug rather than as compactness — so the name is dropped
 * entirely until it fits whole *and* still leaves clear space before the action
 * group. Both are geometry, not a guessed breakpoint: the nav card is user
 * resizable and nicknames differ in width, so the answer comes from the measured
 * row, the measured name and the measured action group.
 */
export interface ProfileFooterMetrics {
  /** Footer border-box width (`clientWidth`, whose padding is already included). */
  footerWidth: number
  /** Left + right footer padding. */
  padding: number
  /** Gap between the profile button and the action group. */
  gap: number
  /** Rendered width of the action group. */
  actionsWidth: number
  /** Portrait diameter. */
  avatarSize: number
  /** Horizontal padding inside the profile button. */
  buttonPadding: number
  /** Gap between the portrait and the nickname. */
  nameGap: number
  /** Natural (unclamped) width of the nickname. */
  nameWidth: number
  /** Clear space that has to survive between the nickname and the action group. */
  minGap?: number
}

/** Clear space the nickname must leave before the action group. */
export const PROFILE_NAME_MIN_GAP = 10

/**
 * True only when the whole nickname fits beside the portrait with at least
 * `minGap` px left over before the actions. A row that has not been laid out
 * (`footerWidth` or `nameWidth` of 0) never reports a fit: claiming one there
 * would render the name before the measurement that justifies it.
 */
export function profileNameFits(metrics: ProfileFooterMetrics): boolean {
  const {
    footerWidth, padding, gap, actionsWidth, avatarSize,
    buttonPadding, nameGap, nameWidth, minGap = PROFILE_NAME_MIN_GAP,
  } = metrics
  if (!(footerWidth > 0) || !(nameWidth > 0)) return false
  const needed = padding + buttonPadding * 2 + avatarSize + nameGap + nameWidth + minGap + gap + actionsWidth
  return needed <= footerWidth
}
