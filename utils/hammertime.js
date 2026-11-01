// utils/hammertime.js

/**
 * Converts a time amount + unit into a future Unix timestamp, or parses raw timestamps/Dates.
 * 
 * @param {number|Date|string} timeInput - Can be:
 *   - A Date object
 *   - A Unix timestamp (seconds or milliseconds)
 *   - An integer paired with a unit string (e.g., passing value to create future times)
 * @param {string} [unit] - The unit for timeInput if it's a number duration ('months', 'weeks', 'days', 'hours', 'minutes')
 * @param {string} style - Discord timestamp style ('t', 'T', 'd', 'D', 'f', 'F', 'R')
 * @returns {string} The Discord markdown timestamp string.
 */
function toDiscordTimestamp(timeInput, unit = 'f', style = 'f') {
    let targetTimestampMs;

    // If unit is actually a style string (user skipped the unit argument)
    if (['t', 'T', 'd', 'D', 'f', 'F', 'R'].includes(unit)) {
        style = unit;
        unit = null;
    }

    if (timeInput instanceof Date) {
        targetTimestampMs = timeInput.getTime();
    } else if (typeof timeInput === 'number' && unit && ['month', 'months', 'week', 'weeks', 'day', 'days', 'hour', 'hours', 'minute', 'minutes'].includes(unit.toLowerCase())) {
        // Calculate future timestamp from a duration (months to minutes)
        const now = Date.now();
        const multiplier = parseUnitToMilliseconds(unit.toLowerCase());
        targetTimestampMs = now + (timeInput * multiplier);
    } else if (typeof timeInput === 'number') {
        // Raw timestamp input (seconds or milliseconds)
        targetTimestampMs = timeInput > 10000000000 ? timeInput : timeInput * 1000;
    } else {
        throw new Error('Invalid time input provided to hammertime utility.');
    }

    const seconds = Math.floor(targetTimestampMs / 1000);
    return `<t:${seconds}:${style}>`;
}

/**
 * Helper to convert time units into milliseconds (approximate for months = 30 days)
 */
function parseUnitToMilliseconds(unit) {
    switch (unit) {
        case 'month':
        case 'months':
            return 30 * 24 * 60 * 60 * 1000; // ~30 days per month
        case 'week':
        case 'weeks':
            return 7 * 24 * 60 * 60 * 1000;
        case 'day':
        case 'days':
            return 24 * 60 * 60 * 1000;
        case 'hour':
        case 'hours':
            return 60 * 60 * 1000;
        case 'minute':
        case 'minutes':
            return 60 * 1000;
        default:
            return 0;
    }
}

module.exports = { toDiscordTimestamp };