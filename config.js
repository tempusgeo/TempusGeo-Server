require('dotenv').config();

/** מפת שם חג (אנגלית/עברית כפי בלוח שנה) → קטגוריית סקטור. מקור יחיד לשרת וללקוחות (דרך API). */
const HOLIDAY_CATEGORY_MAP = {
    "17th of Tammuz": "יהדות",
    "Asarah B'Tevet (Tenth of Tevet)": "יהדות",
    "Fast of Esther": "יהדות",
    "Gedaliah Fast": "יהדות",
    "Sigd": "יהדות",
    "חנוכה": "יהדות",
    "יום כיפור": "יהדות",
    "ל״ג בעומר": "יהדות",
    "מימונה": "יהדות",
    "סוכות": "יהדות",
    "ערב יום כיפור": "יהדות",
    "ערב סוכות": "יהדות",
    "ערב פורים": "יהדות",
    "ערב פסח": "יהדות",
    "ערב ראש השנה": "יהדות",
    "ערב שבועות": "יהדות",
    "ערב תשעה באב": "יהדות",
    "פורים": "יהדות",
    "פסח": "יהדות",
    "ראש השנה": "יהדות",
    "שבועות": "יהדות",
    "שמחת תורה": "יהדות",
    "תשעה באב": "יהדות",
    "Al Isra' wal Miraj": "אסלאם",
    "Al Isra' wal Miraj (tentative)": "אסלאם",
    "Ashura": "אסלאם",
    "Ashura (tentative)": "אסלאם",
    "Lailat al-Qadr": "אסלאם",
    "יום הולדת הנביא": "אסלאם",
    "יום ראשון של כפות התמרים": "אסלאם",
    "ליילאת אל מיראז'": "אסלאם",
    "ערב יום הולדת הנביא": "אסלאם",
    "ערב ראש השנה המוסלמי": "אסלאם",
    "ערב עיד אל-אדחא": "אסלאם",
    "ערב עיד אל-פיטר": "אסלאם",
    "עיד אל-אדחא": "אסלאם",
    "עיד אל-פיטר": "אסלאם",
    "Eid al-Fitr": "אסלאם",
    "Eid al-Adha": "אסלאם",
    "Ramadan": "אסלאם",
    "Islamic New Year": "אסלאם",
    "ראש השנה המוסלמי": "אסלאם",
    "רמדאן": "אסלאם",
    "Eid al-Khader": "דרוזים",
    "Eid al-Khader Eve": "דרוזים",
    "Feast of Prophet Sabalan": "דרוזים",
    "Feast of Prophet Sabalan Eve": "דרוזים",
    "Prophet Shuaib's Feast": "דרוזים",
    "Prophet Shuaib's Feast Eve": "דרוזים",
    "Prophet Shuaib's Feast Holiday": "דרוזים",
    "All Saints' Day": "נצרות",
    "All Souls' Day": "נצרות",
    "Armenian Feast of the Annunciation": "נצרות",
    "Armenian/Orthodox Ascension Day": "נצרות",
    "Armenian/Orthodox Ascension Eve": "נצרות",
    "Armenian/Orthodox Holy Saturday": "נצרות",
    "Armenian/Orthodox Maundy Thursday": "נצרות",
    "Armenian/Orthodox Pentecost": "נצרות",
    "Armenian/Orthodox Pentecost Eve": "נצרות",
    "Armenian/Orthodox Pentecost Monday": "נצרות",
    "Ascension Day": "נצרות",
    "Assumption of Mary": "נצרות",
    "Catholic/Protestant Ascension Day": "נצרות",
    "Catholic/Protestant Ascension Eve": "נצרות",
    "Catholic/Protestant Boxing Day": "נצרות",
    "Catholic/Protestant Epiphany": "נצרות",
    "Catholic/Protestant Epiphany Eve": "נצרות",
    "Catholic/Protestant Feast of the Annunciation": "נצרות",
    "Catholic/Protestant Holy Saturday": "נצרות",
    "Catholic/Protestant Maundy Thursday": "נצרות",
    "Catholic/Protestant Pentecost": "נצרות",
    "Catholic/Protestant Pentecost Eve": "נצרות",
    "Catholic/Protestant Pentecost Monday": "נצרות",
    "Corpus Christi": "נצרות",
    "Epiphany": "נצרות",
    "Feast of Our Lady of Guadalupe": "נצרות",
    "Feast of St Francis of Assisi": "נצרות",
    "Feast of the Immaculate Conception": "נצרות",
    "First Sunday of Advent": "נצרות",
    "Holy Saturday": "נצרות",
    "Maundy Thursday": "נצרות",
    "Orthodox Epiphany Day": "נצרות",
    "Orthodox Epiphany Eve": "נצרות",
    "Orthodox Feast of the Annunciation": "נצרות",
    "Orthodox New Year": "נצרות",
    "Orthodox New Year's Eve": "נצרות",
    "Pentecost": "נצרות",
    "Shrove Tuesday/Mardi Gras": "נצרות",
    "Trinity Sunday": "נצרות",
    "Whit Monday": "נצרות",
    "חג המולד": "נצרות",
    "יום רביעי של האפר": "נצרות",
    "יום שישי הטוב": "נצרות",
    "ערב חג המולד": "נצרות",
    "פסחא": "נצרות",
    "Aliyah Day School Observance": "ממלכתי וכללי",
    "Herzl's Death Anniversary": "ממלכתי וכללי",
    "International Women's Day": "ממלכתי וכללי",
    "Jerusalem Day": "ממלכתי וכללי",
    "May Day": "ממלכתי וכללי",
    "New Year's Eve": "ממלכתי וכללי",
    "St. David's Day": "ממלכתי וכללי",
    "St. Patrick's Day": "ממלכתי וכללי",
    "Victory Day over Nazi Germany": "ממלכתי וכללי",
    "Yom HaAtzmaut": "ממלכתי וכללי",
    "Yom HaShoah": "ממלכתי וכללי",
    "Yom HaZikaron": "ממלכתי וכללי",
    "First Day of School Year": "ממלכתי וכללי",
    "יום הזיכרון": "ממלכתי וכללי",
    "יום העצמאות": "ממלכתי וכללי",
    "יום השואה": "ממלכתי וכללי",
    "ראש השנה (אזרחי)": "ממלכתי וכללי",
    "Holocaust Remembrance Day": "ממלכתי וכללי",
    "Memorial Day": "ממלכתי וכללי",
    "Independence Day": "ממלכתי וכללי"
};

module.exports = {
    PORT: process.env.PORT || 3000,
    APP_URL: process.env.RENDER_URL || "https://tg-users.netlify.app/#", // Fallback for emails
    DATA_DIR: process.env.DATA_DIR || './data',

    // Security
    JWT_SECRET: process.env.JWT_SECRET || 'tempusgeo_secret_123', // Change in production!

    // External APIs
    TRANZILA: {
        BASE_URL: process.env.TRANZILA_BASE_URL || "https://direct.tranzila.com",
        API_URL: process.env.TRANZILA_API_URL || "https://secure5.tranzila.com/cgi-bin/tranzila71u.cgi"
    },

    // GAS Cold Storage (for historical data)
    GAS_COLD_STORAGE_URL: process.env.GAS_COLD_STORAGE_URL || "https://script.google.com/macros/s/AKfycbzNUL7jYvogl7_gwDSHVWSvEPWrdHF1-gfA4wBD5wN7koTNs5Mcn2r_b1FHwuvimYNncA/exec", // Set this to your GAS Web App URL
    MY_GAS_URL: process.env.MY_GAS_URL,

    // JetServer Payment Proxy
    JETSERVER_PAYMENT_URL: process.env.JETSERVER_PROXY_URL || process.env.JETSERVER_PAYMENT_URL,
    JETSERVER_PROXY_URL: process.env.JETSERVER_PROXY_URL,
    JETSERVER_TOKEN: process.env.JETSERVER_TOKEN || process.env.JETSERVER_MAIL_SECRET,

    // Tranzila Credentials (Required for server-side charging)
    TRANZILA_TERMINAL_NAME: process.env.TRANZILA_TERMINAL_NAME,
    TRANZILA_TERMINAL_PASS: process.env.TRANZILA_TERMINAL_PASS,

    // JetServer Mail Proxy (Bypasses Render SMTP Block)
    JETSERVER_MAIL_URL: process.env.JETSERVER_MAIL_URL,
    JETSERVER_MAIL_SECRET: process.env.JETSERVER_MAIL_SECRET,

    // Email Config
    // Optional: Use professional SMTP (SendGrid, Mailgun, SES, etc.)
    // If not set, falls back to GAS_COLD_STORAGE_URL (Google Apps Script)
    SMTP: {
        HOST: process.env.SMTP_HOST || null,
        PORT: process.env.SMTP_PORT || 587,
        USER: process.env.SMTP_USER || null,
        PASS: process.env.SMTP_PASS || null,
        FROM: process.env.SMTP_FROM || 'no-reply@tempusgeo.com'
    },

    // System Config
    APP_NAME: "TempusGeo",
    MAJOR_HOLIDAYS: [
        'ראש השנה', 'יום כיפור', 'סוכות', 'פסח', 'שבועות', 'יום העצמאות',
        'רמדאן', 'עיד אל-פיטר', 'עיד אל-אדחא', 'חג המולד', 'פסחא'
    ],
    HOLIDAY_MAPPING: {
        "Rosh Hashana": "ראש השנה",
        "Yom Kippur": "יום כיפור",
        "Sukkot": "סוכות",
        "Simchat Torah": "שמחת תורה",
        "Hanukkah": "חנוכה",
        "Purim": "פורים",
        "Seventh day of Passover": "שביעי של פסח",
        "Passover": "פסח",
        "Mimouna": "מימונה",
        "Shavuot": "שבועות",
        "Tisha B'Av": "תשעה באב",
        "Tu B'Av": "ט\"ו באב",
        "Lag BaOmer": "ל\"ג בעומר",
        "Ramadan": "רמדאן",
        "Eid al-Fitr": "עיד אל-פיטר",
        "Eid al-Adha": "עיד אל-אדחא",
        "Muharram": "ראש השנה המוסלמי",
        "Islamic New Year": "ראש השנה המוסלמי",
        "Prophet's Birthday": "יום הולדת הנביא",
        "Independence Day": "יום העצמאות",
        "Holocaust Remembrance Day": "יום השואה",
        "Memorial Day": "יום הזיכרון"
    },

    HOLIDAY_CATEGORY_MAP
};
