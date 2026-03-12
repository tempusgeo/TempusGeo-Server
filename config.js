require('dotenv').config();

module.exports = {
    PORT: process.env.PORT || 3000,
    APP_URL: process.env.RENDER_URL || "http://localhost:3000", // Fallback for emails
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

    // JetServer Payment Proxy
    JETSERVER_PROXY_URL: process.env.JETSERVER_PROXY_URL,
    JETSERVER_TOKEN: process.env.JETSERVER_TOKEN || process.env.JETSERVER_MAIL_SECRET,

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
        "Prophet's Birthday": "יום הולדת הנביא",
        "Independence Day": "יום העצמאות",
        "Holocaust Remembrance Day": "יום השואה",
        "Memorial Day": "יום הזיכרון"
    }
};
