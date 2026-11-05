/**
 * Central timing profile.
 *
 * Every artificial delay in the automation goes through here so the whole run can
 * be sped up or slowed down with one knob:
 *
 *   SPEED=1      original, most human-like (slowest)
 *   SPEED=0.3    default — ~3x faster on the typing/pause portions
 *   SPEED=0.2    aggressive — fastest measured, highest risk of tripping bot checks
 *
 * Lower is faster. Floors keep individual steps from collapsing to 0ms, which
 * would defeat the point of pacing at all.
 */

const RAW_SPEED = Number(process.env.SPEED ?? '0.3');
const SPEED = Number.isFinite(RAW_SPEED) && RAW_SPEED > 0 ? RAW_SPEED : 0.3;

/** Minimum per-keystroke delay in ms — below this, typing looks mechanical. */
const MIN_KEY_DELAY_MS = 12;
/** Minimum pause anywhere, so nothing becomes a zero-length await. */
const MIN_PAUSE_MS = 8;

/**
 * Scale a duration by the speed profile.
 * @param {number} ms
 * @param {number} [floor]
 */
function scale(ms, floor = MIN_PAUSE_MS) {
  return Math.max(floor, Math.round(ms * SPEED));
}

/** Scale a [min,max] range and return one value inside it. */
function scaleRange(min, max) {
  return scale(min + Math.random() * (max - min));
}

/** Scale a keyboard inter-key delay, with its own floor. */
function scaleKey(ms) {
  return Math.max(MIN_KEY_DELAY_MS, Math.round(ms * SPEED));
}

/** Awaitable sleep that respects the profile. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, scale(ms)));
}

/** True when running in the fast/aggressive profile. */
const isFast = SPEED <= 0.5;

module.exports = {
  SPEED,
  MIN_KEY_DELAY_MS,
  MIN_PAUSE_MS,
  scale,
  scaleRange,
  scaleKey,
  sleep,
  isFast
};
