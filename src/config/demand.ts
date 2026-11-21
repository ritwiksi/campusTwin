// Historic 2018 ComStock window. Quarter-hour loads come from /api/comstock,
// not generated trigonometric or synthetic electricity curves.
export const START = Date.UTC(2018, 8, 1)
export const INTERVALS_PER_DAY = 96
export const TOTAL_FRAMES = 91 * INTERVALS_PER_DAY
