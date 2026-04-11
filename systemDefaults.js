/**
 * Canonical system defaults (embedded). Admin UI and APIs merge these with
 * persisted system_config so hardcoded values become the admin-editable layer.
 */

const config = require('./config');

const SECTORS = ['יהדות', 'אסלאם', 'דרוזים', 'נצרות'];

/** Same list as CLIENT_USER when loading sector "יהדות" without admin config */
const DEFAULT_JEWISH_HOLIDAYS = [
    'פסח', 'מימונה' ,'סוכות', 'ראש השנה', 'יום כיפור', 'שבועות', 'יום העצמאות', 'שמחת תורה'
];

/**
 * Mirrors CLIENT_USER getHolidaysBySector (non-Jewish sectors use category map).
 */
function holidaysForSector(sector) {
    const holidays = ['יום העצמאות', 'Yom HaAtzmaut'];
    const categoryMap = {
        "חנוכה": "יהדות", "יום כיפור": "יהדות", "סוכות": "יהדות", "פורים": "יהדות", "פסח": "יהדות", "ראש השנה": "יהדות", "שבועות": "יהדות", "שמחת תורה": "יהדות",
        "17th of Tammuz": "יהדות", "Asarah B'Tevet (Tenth of Tevet)": "יהדות", "Fast of Esther": "יהדות", "Gedaliah Fast": "יהדות", "Sigd": "יהדות", "ל״ג בעומר": "יהדות", "מימונה": "יהדות", "תשעה באב": "יהדות",
        "עיד אל-אדחא": "אסלאם", "עיד אל-פיטר": "אסלאם", "ראש השנה המוסלמי": "אסלאם", "יום הולדת הנביא": "אסלאם", "Al Isra' wal Miraj": "אסלאם", "Al Isra' wal Miraj (tentative)": "אסלאם", "Ashura": "אסלאם", "Ashura (tentative)": "אסלאם", "Lailat al-Qadr": "אסלאם", "ליילאת אל מיראז'": "אסלאם",
        "Eid al-Khader": "דרוזים", "Feast of Prophet Sabalan": "דרוזים", "Prophet Shuaib's Feast": "דרוזים", "Prophet Shuaib's Feast Holiday": "דרוזים",
        "חג המולד": "נצרות", "All Saints' Day": "נצרות", "All Souls' Day": "נצרות", "Armenian Feast of the Annunciation": "נצרות", "Armenian/Orthodox Ascension Day": "נצרות", "Armenian/Orthodox Holy Saturday": "נצרות", "Armenian/Orthodox Maundy Thursday": "נצרות", "Armenian/Orthodox Pentecost": "נצרות", "Armenian/Orthodox Pentecost Monday": "נצרות", "Ascension Day": "נצרות", "Assumption of Mary": "נצרות", "Catholic/Protestant Ascension Day": "נצרות", "Catholic/Protestant Boxing Day": "נצרות", "Catholic/Protestant Epiphany": "נצרות", "Catholic/Protestant Feast of the Annunciation": "נצרות", "Catholic/Protestant Holy Saturday": "נצרות", "Catholic/Protestant Maundy Thursday": "נצרות", "Catholic/Protestant Pentecost": "נצרות", "Catholic/Protestant Pentecost Monday": "נצרות", "Corpus Christi": "נצרות", "Epiphany": "נצרות", "Feast of Our Lady of Guadalupe": "נצרות", "Feast of St Francis of Assisi": "נצרות", "Feast of the Immaculate Conception": "נצרות", "First Sunday of Advent": "נצרות", "Holy Saturday": "נצרות", "Maundy Thursday": "נצרות", "Orthodox Epiphany Day": "נצרות", "Orthodox Feast of the Annunciation": "נצרות", "Orthodox New Year": "נצרות", "Pentecost": "נצרות", "Shrove Tuesday/Mardi Gras": "נצרות", "Trinity Sunday": "נצרות", "Whit Monday": "נצרות", "יום ראשון של כפות התמרים": "נצרות", "יום רביעי של האפר": "נצרות"
    };
    for (const [key, val] of Object.entries(categoryMap)) {
        if (val === sector) holidays.push(key);
    }
    return Array.from(new Set(holidays));
}

function getEmbeddedDefaultHolidaysBySector() {
    return {
        'יהדות': [...DEFAULT_JEWISH_HOLIDAYS],
        'אסלאם': holidaysForSector('אסלאם'),
        'דרוזים': holidaysForSector('דרוזים'),
        'נצרות': holidaysForSector('נצרות')
    };
}

/**
 * Per sector: use stored array if present (including []); else embedded list.
 */
function mergeDefaultHolidaysBySector(stored) {
    const embedded = getEmbeddedDefaultHolidaysBySector();
    const out = {};
    for (const s of SECTORS) {
        if (stored && Object.prototype.hasOwnProperty.call(stored, s) && Array.isArray(stored[s])) {
            out[s] = stored[s].slice();
        } else {
            out[s] = embedded[s].slice();
        }
    }
    return out;
}

/**
 * Plain-text intros shown in admin and used as "restore default" (EmailService HTML fallbacks match meaning).
 */
function getEmailTemplatePlainDefaults(appName) {
    const name = (appName && String(appName).trim()) || config.APP_NAME || 'TempusGeo';
    return {
        welcomeIntro: `אנחנו שמחים שהצטרפת למערכת ${name}! החשבון שלך נוצר בהצלחה.`,
        expiryIntro: 'תוקף המנוי למערכת הוא עד תאריך שיוצג במייל (נקבע אוטומטית לפי חשבון העסק).',
        graceIntro: 'תוקף המנוי שלך פג בתאריך שיוצג במייל (נקבע אוטומטית לפי חשבון העסק).',
        blockedIntro: 'הגישה למערכת נעצרה עקב פקיעת מנוי / חוב. לאחר עדכון התשלום תוכל לחזור לפעילות רגילה.',
        paymentSuccessIntro: 'שמחים לעדכן כי התשלום החודשי עבור המנוי בוצע בהצלחה.'
    };
}

module.exports = {
    SECTORS,
    DEFAULT_JEWISH_HOLIDAYS,
    getEmbeddedDefaultHolidaysBySector,
    mergeDefaultHolidaysBySector,
    getEmailTemplatePlainDefaults
};
