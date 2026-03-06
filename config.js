require('dotenv').config();

module.exports = {
    PORT: process.env.PORT || 3000,
    DATA_DIR: process.env.DATA_DIR || './data',

    // Security
    JWT_SECRET: process.env.JWT_SECRET || 'tempusgeo_secret_123', // Change in production!

    // External APIs
    TRANZILA: {
        BASE_URL: process.env.TRANZILA_BASE_URL || "https://direct.tranzila.com",
        API_URL: process.env.TRANZILA_API_URL || "https://secure5.tranzila.com/cgi-bin/tranzila71u.cgi"
    },

    // GAS Cold Storage (for historical data)
    GAS_COLD_STORAGE_URL: process.env.GAS_COLD_STORAGE_URL || null, // Set this to your GAS Web App URL

    // JetServer Payment Proxy
    JETSERVER_PAYMENT_URL: process.env.JETSERVER_PAYMENT_URL || "https://your-domain.com/TempusGeo/process_payment.php",

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
    MAJOR_HOLIDAYS: ['׳¨׳ ׳© ׳”׳©׳ ׳”', '׳›׳™׳₪׳•׳¨', '׳¡׳•׳›׳•׳×', '׳₪׳¡׳—', '׳©׳‘׳•׳¢׳•׳×', '׳”׳¢׳¦׳ž׳ ׳•׳×'],
    HOLIDAY_MAPPING: {
        "Rosh Hashana": "׳¨׳ ׳© ׳”׳©׳ ׳”",
        "Yom Kippur": "׳™׳•׳  ׳›׳™׳₪׳•׳¨",
        "Sukkot": "׳¡׳•׳›׳•׳×",
        "Simchat Torah": "׳©׳ž׳—׳× ׳×׳•׳¨׳”",
        "Hanukkah": "׳—׳ ׳•׳›׳”",
        "Purim": "׳₪׳•׳¨׳™׳ ",
        "Passover": "׳₪׳¡׳—",
        "Shavuot": "׳©׳‘׳•׳¢׳•׳×",
        "Tisha B'Av": "׳×׳©׳¢׳” ׳‘׳ ׳‘",
        "Tu B'Av": "׳˜׳´׳• ׳‘׳ ׳‘",
        "Lag BaOmer": "׳œ׳´׳’ ׳‘׳¢׳•׳ž׳¨",
        "Ramadan": "׳¨׳ž׳“׳ ׳Ÿ",
        "Eid al-Fitr": "׳¢׳™׳“ ׳ ׳œ-׳₪׳™׳˜׳¨",
        "Eid al-Adha": "׳¢׳™׳“ ׳ ׳œ-׳ ׳“׳—׳ ",
        "Muharram": "׳¨׳ ׳© ׳”׳©׳ ׳” ׳”׳ž׳•׳¡׳œ׳ž׳™",
        "Prophet's Birthday": "׳™׳•׳  ׳”׳•׳œ׳“׳× ׳”׳ ׳‘׳™׳ ",
        "Independence Day": "׳™׳•׳  ׳”׳¢׳¦׳ž׳ ׳•׳×",
        "Holocaust Remembrance Day": "׳™׳•׳  ׳”׳©׳•׳ ׳”",
        "Memorial Day": "׳™׳•׳  ׳”׳–׳™׳›׳¨׳•׳Ÿ"
    }
};
