class WageCalculator {
    /**
     * Calculates the wage breakdown for an array of shifts based on salary settings.
     * @param {Array} shifts - Array of shift objects {start, end} (timestamps)
     * @param {Object} salarySettings - The company's salary/overtime config
     * @returns {Object} { totalHours, breakdown: { rateName: hoursCount } }
     */
    static calculateBreakdown(shifts, salarySettings = {}, holidayDates = []) {
        let totalHoursAll = 0;
        let breakdown = {
            100: 0
        };

        const tz = 'Asia/Jerusalem';

        // Helper: Get localized Date components in Asia/Jerusalem
        const getLocalized = (timestamp) => {
            const date = new Date(timestamp);
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false
            });
            const parts = formatter.formatToParts(date);
            const p = {};
            parts.forEach(part => p[part.type] = part.value);
            
            return {
                year: parseInt(p.year),
                month: parseInt(p.month),
                day: parseInt(p.day),
                hours: parseInt(p.hour),
                minutes: parseInt(p.minute),
                dayOfWeek: date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' }), // Sun, Mon...
                dayOfWeekNum: [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ].indexOf(date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })),
                isoDate: `${p.year}-${p.month.padStart(2, '0')}-${p.day.padStart(2, '0')}`
            };
        };

        // Helper: Convert "18:00" to minutes from midnight
        const timeToMinutes = (timeStr) => {
            if (!timeStr) return 0;
            const [h, m] = timeStr.split(':').map(Number);
            return (h * 60) + (m || 0);
        };

        const weStartMins = timeToMinutes(salarySettings.weekend?.startHour || salarySettings.weekendStart || '15:00');
        const weEndMins = timeToMinutes(salarySettings.weekend?.endHour || salarySettings.weekendEnd || '20:00');

        // Overtime configuration (Fallback to default Israeli law 100% 8h, 125% 2h, 150% rest)
        const otMapObj = salarySettings.overtimeRates || {};
        const otMapArr = salarySettings.overtimeMapping || [0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.25, 0.5, 0.5]; // Support legacy

        // Special Days configuration (Shabbat & Holidays)
        const weMapObj = salarySettings.weekendMapping || {};

        shifts.forEach(s => {
            if (!s.start || !s.end) return;
            const startMs = parseInt(s.start) || s.start;
            const endMs = parseInt(s.end) || s.end;

            const shiftStart = new Date(startMs);
            const shiftEnd = new Date(endMs);

            if (isNaN(shiftStart) || isNaN(shiftEnd)) return;

            const diffMs = shiftEnd - shiftStart;
            let totalShiftHours = diffMs / 3600000;
            totalHoursAll += totalShiftHours;

            // Helper to check if a specific timestamp is "Special" (Shabbat/Holiday)
            const getIsSpecial = (timestamp) => {
                const loc = getLocalized(timestamp);
                const dayOfWeek = loc.dayOfWeekNum; 
                const minsFromMidnight = loc.hours * 60 + loc.minutes;
                const isoDate = loc.isoDate;

                const isTodayHoliday = holidayDates.includes(isoDate);

                // 1. Shabbat Check
                if (dayOfWeek === 5 && minsFromMidnight >= weStartMins) return true; // Fri Eve
                if (dayOfWeek === 6 && minsFromMidnight < weEndMins) return true; // Sat

                // 2. Holiday Check
                // We need tomorrow to detect Eve start
                const tomorrowLoc = getLocalized(timestamp + 86400000);
                const isTomorrowHoliday = holidayDates.includes(tomorrowLoc.isoDate);

                if (!isTodayHoliday && isTomorrowHoliday) {
                    // EVE: Today NOT holiday, Tomorrow IS. Starts at weStartMins.
                    if (minsFromMidnight >= weStartMins) return true;
                } else if (isTodayHoliday && isTomorrowHoliday) {
                    // MIDDLE: Both IS holiday. Full day.
                    return true;
                } else if (isTodayHoliday && !isTomorrowHoliday) {
                    // END: Today IS holiday, Tomorrow NOT. Ends at weEndMins.
                    if (minsFromMidnight < weEndMins) return true;
                }

                return false;
            };

            // Iterate minute by minute
            const totalMinutes = Math.floor(diffMs / 60000);
            for (let m = 0; m < totalMinutes; m++) {
                const currentTs = startMs + (m * 60000);
                const isSpecialNow = getIsSpecial(currentTs);

                // Which hour of the shift are we in? (1-indexed)
                const hourIndex = Math.floor(m / 60) + 1;

                let ratePercent = 100;

                if (isSpecialNow) {
                    let addedRate = 0.5; // Default 150%
                    if (weMapObj[`h${hourIndex}`] !== undefined) {
                        addedRate = parseFloat(weMapObj[`h${hourIndex}`]);
                    } else if (hourIndex >= 9) {
                        addedRate = 0.75; // Default 175%
                    }
                    ratePercent = 100 + (addedRate * 100);
                } else {
                    let addedRate = 0;
                    if (otMapObj[`h${hourIndex}`] !== undefined) {
                        addedRate = parseFloat(otMapObj[`h${hourIndex}`]);
                    } else if (otMapArr && otMapArr[hourIndex - 1] !== undefined) {
                        addedRate = parseFloat(otMapArr[hourIndex - 1]);
                    } else {
                        // Default Israeli Law Overtime
                        if (hourIndex === 9 || hourIndex === 10) addedRate = 0.25;
                        else if (hourIndex >= 11) addedRate = 0.5;
                    }
                    ratePercent = 100 + (addedRate * 100);
                }

                if (!breakdown[ratePercent]) breakdown[ratePercent] = 0;
                breakdown[ratePercent] += (1 / 60); // Add 1 minute as fraction of hour
            }

            // Handle remaining seconds/fractional minute if any
            const remainingMs = diffMs % 60000;
            if (remainingMs > 0) {
                const currentTs = startMs + (totalMinutes * 60000);
                const isSpecialNow = getIsSpecial(currentTs);
                const hourIndex = Math.floor(totalMinutes / 60) + 1;
                const fractionOfHour = remainingMs / 3600000;

                let ratePercent = 100;
                // Same rate logic as above (DRY note: in production this would be a function)
                if (isSpecialNow) {
                    let addedRate = weMapObj[`h${hourIndex}`] !== undefined ? parseFloat(weMapObj[`h${hourIndex}`]) : (hourIndex >= 9 ? 0.75 : 0.5);
                    ratePercent = 100 + (addedRate * 100);
                } else {
                    let addedRate = 0;
                    if (otMapObj[`h${hourIndex}`] !== undefined) {
                        addedRate = parseFloat(otMapObj[`h${hourIndex}`]);
                    } else if (otMapArr && otMapArr[hourIndex - 1] !== undefined) {
                        addedRate = parseFloat(otMapArr[hourIndex - 1]);
                    } else {
                        if (hourIndex === 9 || hourIndex === 10) addedRate = 0.25;
                        else if (hourIndex >= 11) addedRate = 0.5;
                    }
                    ratePercent = 100 + (addedRate * 100);
                }
                if (!breakdown[ratePercent]) breakdown[ratePercent] = 0;
                breakdown[ratePercent] += fractionOfHour;
            }
        });

        // Format to 2 decimals
        for (const key in breakdown) {
            breakdown[key] = parseFloat(breakdown[key].toFixed(2));
            if (breakdown[key] === 0) delete breakdown[key];
        }

        // Calculate weightedTotal for wages
        let weightedTotal = 0;
        for (const [rate, hours] of Object.entries(breakdown)) {
            weightedTotal += hours * (parseFloat(rate) / 100);
        }

        return {
            totalHours: parseFloat(totalHoursAll.toFixed(2)),
            weightedTotal: parseFloat(weightedTotal.toFixed(2)),
            breakdown
        };
    }
}

module.exports = WageCalculator;
