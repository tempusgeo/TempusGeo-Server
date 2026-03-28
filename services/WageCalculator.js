class WageCalculator {
    /**
     * Calculates the wage breakdown for an array of shifts based on salary settings.
     * @param {Array} shifts - Array of shift objects {start, end} (timestamps)
     * @param {Object} salarySettings - The company's salary/overtime config
     * @returns {Object} { totalHours, breakdown: { rateName: hoursCount } }
     */
    static calculateBreakdown(shifts, salarySettings = {}, holidayDates = [], workWeekType = '5day') {
        let totalHoursAll = 0;
        let weightedTotal = 0;
        let breakdown = { 100: 0 };

        const timeToMinutes = (timeStr) => {
            if (!timeStr) return 0;
            const [h, m] = timeStr.split(':').map(Number);
            return (h * 60) + (m || 0);
        };

        const getIsSpecial = (timestamp) => {
            const loc = this.getLocalized(timestamp);
            const mins = loc.hours * 60 + loc.minutes;
            const iso = loc.isoDate;
            const weStart = timeToMinutes(salarySettings.weekend?.startHour || salarySettings.weekendStart || '15:00');
            const weEnd = timeToMinutes(salarySettings.weekend?.endHour || salarySettings.weekendEnd || '20:00');

            if (loc.dayOfWeekNum === 5 && mins >= weStart) return true;
            if (loc.dayOfWeekNum === 6 && mins < weEnd) return true;
            if (holidayDates.includes(iso)) return true;
            
            const tomorrowIso = this.getLocalized(timestamp + 86400000).isoDate;
            if (holidayDates.includes(tomorrowIso) && mins >= weStart) return true;
            
            return false;
        };

        shifts.forEach(s => {
            if (!s.start || !s.end) return;
            const startMs = parseInt(s.start);
            const endMs = parseInt(s.end);
            if (isNaN(startMs) || isNaN(endMs)) return;

            const totalMins = Math.floor((endMs - startMs) / 60000);
            
            // Deduct break
            let workedMins = totalMins;
            const minShift = timeToMinutes(salarySettings.breaks?.minShift || '06:00');
            if (totalMins >= minShift) {
                const isSpecialStart = getIsSpecial(startMs);
                const isFriday = this.getLocalized(startMs).dayOfWeekNum === 5;
                const deduct = (isFriday || isSpecialStart) 
                    ? timeToMinutes(salarySettings.breaks?.special || '00:30')
                    : timeToMinutes(salarySettings.breaks?.weekday || '00:45');
                workedMins = Math.max(0, totalMins - deduct);
            }

            for (let i = 0; i < workedMins; i++) {
                const currentTs = startMs + (i * 60000);
                const isSpecial = getIsSpecial(currentTs);
                const loc = this.getLocalized(currentTs);
                const isFriday = loc.dayOfWeekNum === 5;

                let addedRate = 0;
                let ranges = [];

                if (isSpecial) {
                    ranges = salarySettings.weekendRanges || [{ start: '00:00', end: '24:00', addRate: 0.5 }];
                } else {
                    const isHolidayEve = holidayDates.includes(this.getLocalized(currentTs + 86400000).isoDate);
                    if (isFriday || isHolidayEve) {
                        ranges = (workWeekType === '6day') ? salarySettings.fridayRanges6 : salarySettings.fridayRanges5;
                    } else {
                        ranges = (workWeekType === '6day') ? salarySettings.overtimeRanges6 : salarySettings.overtimeRanges5;
                    }
                }

                if (ranges && ranges.length > 0) {
                    const match = ranges.find(r => {
                        const rStart = timeToMinutes(r.start);
                        const rEnd = timeToMinutes(r.end);
                        return i >= rStart && i < rEnd;
                    });
                    if (match) addedRate = parseFloat(match.addRate);
                    else addedRate = parseFloat(ranges[ranges.length - 1].addRate);
                }

                const rate = 100 + (addedRate * 100);
                breakdown[rate] = (breakdown[rate] || 0) + (1 / 60);
                totalHoursAll += (1 / 60);
                weightedTotal += (1 / 60) * (rate / 100);
            }
        });

        // Cleanup and format
        for (const k in breakdown) {
            breakdown[k] = parseFloat(breakdown[k].toFixed(2));
            if (breakdown[k] <= 0) delete breakdown[k];
        }

        return {
            totalHours: parseFloat(totalHoursAll.toFixed(2)),
            weightedTotal: parseFloat(weightedTotal.toFixed(2)),
            breakdown
        };
    }

    static getLocalized(timestamp) {
        const date = new Date(timestamp);
        const tz = 'Asia/Jerusalem';
        const p = {};
        new Intl.DateTimeFormat('en-US', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
        }).formatToParts(date).forEach(part => p[part.type] = part.value);

        return {
            hours: parseInt(p.hour),
            minutes: parseInt(p.minute),
            dayOfWeekNum: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })),
            isoDate: `${p.year}-${p.month}-${p.day}`
        };
    }
}

module.exports = WageCalculator;

