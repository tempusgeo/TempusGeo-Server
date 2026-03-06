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

        // Helper: Convert "18:00" to minutes from midnight
        const timeToMinutes = (timeStr) => {
            if (!timeStr) return 0;
            const [h, m] = timeStr.split(':').map(Number);
            return (h * 60) + (m || 0);
        };

        const weStartMins = timeToMinutes(salarySettings.weekend?.startHour || salarySettings.weekendStart || '15:00');
        const weEndMins = timeToMinutes(salarySettings.weekend?.endHour || salarySettings.weekendEnd || '20:00');

        const holStartMins = timeToMinutes(salarySettings.holidays?.startHour || salarySettings.holidayStart || '17:00');
        const holEndMins = timeToMinutes(salarySettings.holidays?.endHour || salarySettings.holidayEnd || '19:00');

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

            // Date processing for Special Days (Shabbat / Holidays)
            const dayOfWeek = shiftStart.getDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday
            const shiftStartMins = shiftStart.getHours() * 60 + shiftStart.getMinutes();

            // Format today's date for holiday lookup (yyyy-MM-dd)
            const isoDate = shiftStart.toISOString().split('T')[0];
            const isTodayHoliday = holidayDates.includes(isoDate);

            // Determine if shift starts in a "Special Day" window (Shabbat or Holiday)
            let isSpecialDay = false;

            // Shabbat check
            if (dayOfWeek === 5 && shiftStartMins >= weStartMins) {
                isSpecialDay = true;
            } else if (dayOfWeek === 6 && shiftStartMins < weEndMins) {
                isSpecialDay = true;
            }

            // Holiday check (Erev Chag or Chag day)
            // Note: Simplistic detection - if today is holiday, we check start window. 
            // Better: if today is holiday, it stays special day until holEndMins.
            if (isTodayHoliday && shiftStartMins < holEndMins) {
                isSpecialDay = true;
            }
            // Erev Chag check is harder without knowing tomorrow's holiday. 
            // For now, if the user explicitly marks a day in the holiday dates, we treat it as the Special Day.

            // Iterate hour by hour to assign the precise rate
            for (let i = 1; i <= Math.ceil(totalShiftHours); i++) {
                // If it's the last fractional hour, we only add the fraction
                let hoursInThisSlot = 1;
                if (i > totalShiftHours && i - 1 < totalShiftHours) {
                    hoursInThisSlot = totalShiftHours - (i - 1);
                } else if (i > totalShiftHours) {
                    break;
                }

                let ratePercent = 100; // Base 100%

                if (isSpecialDay) {
                    // Special Day Map (Unified Shabbat & Holiday matrix)
                    let addedRate = 0.5; // Default Special Day base is 150%
                    if (weMapObj[`h${i}`] !== undefined) {
                        addedRate = parseFloat(weMapObj[`h${i}`]);
                    } else if (i >= 8) {
                        addedRate = 0.75; // Default 175% from 8th hour
                    }
                    ratePercent = 100 + (addedRate * 100);
                } else {
                    // Regular Overtime Map
                    let addedRate = 0;
                    if (otMapObj[`h${i}`] !== undefined) {
                        addedRate = parseFloat(otMapObj[`h${i}`]);
                    } else {
                        // User: 8-9 = 125% (+0.25), 10+ = 150% (+0.5)
                        if (i === 8 || i === 9) addedRate = 0.25;
                        else if (i >= 10) addedRate = 0.5;
                        else if (otMapArr && otMapArr[i - 1] !== undefined) {
                            addedRate = parseFloat(otMapArr[i - 1]);
                        }
                    }
                    ratePercent = 100 + (addedRate * 100);
                }

                if (!breakdown[ratePercent]) breakdown[ratePercent] = 0;
                breakdown[ratePercent] += hoursInThisSlot;
            }
        });

        // Format to 2 decimals
        for (const key in breakdown) {
            breakdown[key] = parseFloat(breakdown[key].toFixed(2));
            if (breakdown[key] === 0) delete breakdown[key];
        }

        return {
            totalHours: parseFloat(totalHoursAll.toFixed(2)),
            breakdown
        };
    }
}

module.exports = WageCalculator;
