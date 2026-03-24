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

        // Break Settings
        const breakSettings = salarySettings.breaks || {};
        const minShiftMins = timeToMinutes(breakSettings.minShift || '06:00');
        const breakWeekdayMins = timeToMinutes(breakSettings.weekday || '00:45');
        const breakSpecialMins = timeToMinutes(breakSettings.special || '00:30');

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

            const diffMs = endMs - startMs;
            const totalShiftMinutes = Math.floor(diffMs / 60000);

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
                const tomorrowLoc = getLocalized(timestamp + 86400000);
                const isTomorrowHoliday = holidayDates.includes(tomorrowLoc.isoDate);

                if (!isTodayHoliday && isTomorrowHoliday) {
                    if (minsFromMidnight >= weStartMins) return true;
                } else if (isTodayHoliday && isTomorrowHoliday) {
                    return true;
                } else if (isTodayHoliday && !isTomorrowHoliday) {
                    if (minsFromMidnight < weEndMins) return true;
                }

                return false;
            };

            // 1. Collect all minutes with their "Special" status
            let minutes = [];
            for (let m = 0; m < totalShiftMinutes; m++) {
                const ts = startMs + (m * 60000);
                minutes.push({ isSpecial: getIsSpecial(ts) });
            }

            // 2. Handle fractional last minute
            const remainingMs = diffMs % 60000;
            let fraction = 0;
            let fractionIsSpecial = false;
            if (remainingMs > 0) {
                fraction = remainingMs / 3600000;
                fractionIsSpecial = getIsSpecial(startMs + (totalShiftMinutes * 60000));
            }

            // 3. Apply Break Deduction if eligible
            if (totalShiftMinutes >= minShiftMins) {
                const startLoc = getLocalized(startMs);
                const tomorrowTs = startMs + 86400000;
                const isEve = holidayDates.includes(getLocalized(tomorrowTs).isoDate);
                const isFriday = startLoc.dayOfWeekNum === 5;
                const isSpecialStart = getIsSpecial(startMs);
                const isSpecialDay = isFriday || isEve || isSpecialStart;

                const deductCount = isSpecialDay ? breakSpecialMins : breakWeekdayMins;

                if (deductCount > 0) {
                    // Remove minutes prioritizing regular (non-special) ones
                    let regularIndices = [];
                    let specialIndices = [];
                    minutes.forEach((min, idx) => {
                        if (min.isSpecial) specialIndices.push(idx);
                        else regularIndices.push(idx);
                    });

                    let toRemove = new Set();
                    // First deduct from regular
                    const regToRemove = Math.min(deductCount, regularIndices.length);
                    for (let i = 0; i < regToRemove; i++) toRemove.add(regularIndices[i]);

                    // Then from special if regular not enough
                    const specToRemove = deductCount - regToRemove;
                    if (specToRemove > 0) {
                        for (let i = 0; i < Math.min(specToRemove, specialIndices.length); i++) toRemove.add(specialIndices[i]);
                    }

                    minutes = minutes.filter((_, idx) => !toRemove.has(idx));
                    
                    // If we still have deduction left, apply to the fractional part
                    const finalDeductLeft = deductCount - (regToRemove + Math.min(specToRemove, specialIndices.length));
                    if (finalDeductLeft > 0) {
                        // This usually means the entire shift was shorter than the break (unlikely if > 6h)
                        // but for safety, just zero the fraction
                        fraction = 0;
                    } else if (toRemove.size === deductCount) {
                        // Fully deducted from minutes
                    }
                }
            }

            // 4. Process processed minutes to build breakdown (Overtime applies to worked time)
            minutes.forEach((min, i) => {
                const hourIndex = Math.floor(i / 60) + 1;
                let ratePercent = 100;

                if (min.isSpecial) {
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
                breakdown[ratePercent] += (1 / 60);
                totalHoursAll += (1 / 60);
            });

            // Handle the fraction if anything left
            if (fraction > 0) {
                const hourIndex = Math.floor(minutes.length / 60) + 1;
                let ratePercent = 100;

                if (fractionIsSpecial) {
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
                breakdown[ratePercent] += fraction;
                totalHoursAll += fraction;
            }
        });

        // Format to 2 decimals
        for (const key in breakdown) {
            breakdown[key] = parseFloat(breakdown[key].toFixed(2));
            if (breakdown[key] <= 0) delete breakdown[key];
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
