class WageCalculator {
    /**
     * Calculates the wage breakdown for an array of shifts based on salary settings.
     * @param {Array} shifts - Array of shift objects {start, end} (timestamps)
     * @param {Object} salarySettings - The company's salary/overtime config
     * @returns {Object} { totalHours, breakdown: { rateName: hoursCount } }
     */
    static calculateBreakdown(shifts, salarySettings = {}) {
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

        const weStartMins = timeToMinutes(salarySettings.weekend?.startHour || '15:00');
        const weEndMins = timeToMinutes(salarySettings.weekend?.endHour || '20:00');

        // Overtime configuration (Fallback to default Israeli law 100% 8h, 125% 2h, 150% rest)
        const otMapObj = salarySettings.overtimeRates || {};
        const otMapArr = salarySettings.overtimeMapping || [0, 0, 0, 0, 0, 0, 0, 0, 0.25, 0.25, 0.5, 0.5]; // Support legacy

        // Shabbat configuration (Fallback to strict default 150% 7h, 175% rest)
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

            // Determine if shift starts in Shabbat
            // Shabbat is Friday (day 5) evening to Saturday (day 6) evening
            const dayOfWeek = shiftStart.getDay(); // 0 = Sunday, 5 = Friday, 6 = Saturday
            const shiftStartMins = shiftStart.getHours() * 60 + shiftStart.getMinutes();

            let isShabbat = false;
            if (dayOfWeek === 5 && shiftStartMins >= weStartMins) {
                isShabbat = true;
            } else if (dayOfWeek === 6 && shiftStartMins < weEndMins) {
                isShabbat = true;
            }

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

                if (isShabbat) {
                    // Weekend Map
                    // Get added rate (e.g., 0.5 = +50%, 0.75 = +75%)
                    let addedRate = 0.5; // Default Shabbat base is 150%
                    if (weMapObj[`h${i}`] !== undefined) {
                        addedRate = parseFloat(weMapObj[`h${i}`]);
                    } else if (i > 7) {
                        addedRate = 0.75; // Default 175% from 8th hour
                    }
                    ratePercent = 100 + (addedRate * 100);
                } else {
                    // Regular Overtime Map
                    let addedRate = 0;
                    if (otMapObj[`h${i}`] !== undefined) {
                        addedRate = parseFloat(otMapObj[`h${i}`]);
                    } else if (otMapArr && otMapArr[i - 1] !== undefined) {
                        addedRate = parseFloat(otMapArr[i - 1]);
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
