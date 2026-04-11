/**
 * Canonical system defaults (embedded). Admin UI and APIs merge these with
 * persisted system_config so hardcoded values become the admin-editable layer.
 */

const config = require('./config');

const SECTORS = ['יהדות', 'אסלאם', 'דרוזים', 'נצרות'];

/** Same list as CLIENT_USER when loading sector "יהדות" without admin config */
const DEFAULT_JEWISH_HOLIDAYS = [
    'פסח', 'מימונה', 'סוכות', 'ראש השנה', 'יום כיפור', 'שבועות', 'יום העצמאות', 'שמחת תורה'
];

/**
 * ברירת מחדל מצומצמת לאסלאם: חג לאומי משותף + שני העידים + ראש השנה המוסלמי (ללא רמדאן/לילות קודש וכו').
 */
const ISLAMIC_STATUTORY_HOLIDAYS_IL = ['יום העצמאות', 'עיד אל-פיטר', 'עיד אל-אדחא', 'ראש השנה המוסלמי'];

/**
 * Mirrors CLIENT_USER getHolidaysBySector for דרוזים / נצרות (לא משמש לאסלאם).
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
        'אסלאם': [...ISLAMIC_STATUTORY_HOLIDAYS_IL],
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
 * Escape text for HTML body / subject (admin templates must not inject raw HTML from variables).
 */
function escapeHtmlAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Replace {{key}} placeholders. Values must be pre-sanitized; use escapeHtmlAttr for user strings.
 */
function applyEmailPlaceholders(template, map) {
    if (!template || typeof template !== 'string') return '';
    let out = template;
    for (const [key, val] of Object.entries(map)) {
        const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\{\\{\\s*${safeKey}\\s*\\}\\}`, 'g');
        out = out.replace(re, val == null ? '' : String(val));
    }
    return out;
}

const WELCOME_PLACEHOLDER_HELP = [
    'בתבנית ניתן להשתמש במשתנים הבאים (החלפה אוטומטית בשליחה):',
    '{{businessName}} — שם העסק',
    '{{systemAppName}} — שם המערכת (מיתוג גלובלי)',
    '{{companyId}} — מספר עסק',
    '{{adminPassword}} — סיסמת מנהל ראשונית',
    '{{logoUrl}} — כתובת URL של לוגו (אם קיים)',
    '{{logoImg}} — תג img מוכן ללוגו (או ריק אם אין)',
    '{{workLocationsHtml}} — בלוק HTML עם תיאור אזורי דיווח (או הודעת ברירת מחדל)',
    '{{appUrl}} — קישור כניסה לאפליקציה',
    '{{emailTitle}} — כותרת פנימית במייל (למשל ברוכים הבאים למערכת!)',
    '{{currentYear}} — שנה נוכחית (מספר)'
].join('\n');

/**
 * Full HTML document + subject for welcome email. Admin edits this as the system default layer.
 */
function buildWelcomeEmailDefaults(systemAppName) {
    const app = (systemAppName && String(systemAppName).trim()) || config.APP_NAME || 'TempusGeo';
    const welcomeSubject = 'ברוכים הבאים ל-{{systemAppName}} — {{businessName}}';
    const welcomeHtml = `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        body { margin: 0; padding: 0; }
        @media only screen and (max-width: 600px) {
            .main-container { width: 100% !important; border-radius: 0 !important; }
        }
    </style>
</head>
<body style="background-color: #0f172a; font-family: 'Rubik', sans-serif; color: #ffffff; padding: 10px 0;">
    <div class="main-container" style="max-width: 600px; margin: 0 auto; background-color: #1e293b; border-radius: 12px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.05); box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);">
        <div style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); padding: 20px 15px; text-align: center;">
            {{logoImg}}
            <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700;">{{businessName}}</h1>
        </div>
        <div style="padding: 15px; text-align: right; direction: rtl;">
            <h2 style="color: #ffffff; margin-top: 0; margin-bottom: 15px; font-size: 18px; font-weight: 700; text-align: center;">{{emailTitle}}</h2>
            <div style="background: rgba(0, 0, 0, 0.15); border-radius: 10px; padding: 15px; border: 1px solid rgba(255, 255, 255, 0.05); direction: rtl; text-align: right;">
                <p style="text-align: right; margin-bottom: 15px;">שלום <strong>{{businessName}}</strong>,</p>
                <p style="text-align: right; margin-bottom: 15px;">אנחנו שמחים שהצטרפת למערכת <strong>{{systemAppName}}</strong>! החשבון שלך נוצר בהצלחה.</p>
                <div style="background: rgba(99, 102, 241, 0.1); border-right: 4px solid #6366f1; padding: 20px; margin: 20px 0; border-radius: 12px;">
                    <h3 style="color: #ffffff; font-size: 16px; margin: 0 0 15px 0; text-align: right;">פרטי ההתחברות שלך:</h3>
                    <table style="width: 100%; color: #ffffff; font-size: 14px;">
                        <tr>
                            <td style="color: #94a3b8; text-align: right; padding: 5px 0;">מספר עסק:</td>
                            <td style="text-align: left; font-weight: 700;">{{companyId}}</td>
                        </tr>
                        <tr>
                            <td style="color: #94a3b8; text-align: right; padding: 5px 0;">סיסמת מנהל:</td>
                            <td style="text-align: left; font-weight: 700;">{{adminPassword}}</td>
                        </tr>
                    </table>
                </div>
                <div style="margin: 18px 0;">
                    <p style="color: #94a3b8; font-size: 12px; margin: 0 0 8px 0; font-weight: 700;">מיקומים / אזורי דיווח</p>
                    {{workLocationsHtml}}
                </div>
                <p style="text-align: right; font-size: 14px; color: #94a3b8; line-height: 1.6;">
                    כעת ניתן להתחבר ללוח הבקרה ולהתחיל לנהל את נוכחות העובדים שלך בקלות.<br>
                    מומלץ לשנות את הסיסמה לאחר ההתחברות הראשונית באזור ההגדרות.
                </p>
                <div style="text-align: center; margin-top: 30px;">
                    <a href="{{appUrl}}" style="display: inline-block; background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 12px; font-weight: 800; font-size: 16px; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);">כניסה למערכת</a>
                </div>
            </div>
        </div>
        <div style="background-color: rgba(15, 23, 42, 0.5); padding: 15px; text-align: center; border-top: 1px solid rgba(255, 255, 255, 0.05);">
            <p style="margin: 0; color: #64748b; font-size: 12px;">
                מערכת {{systemAppName}} — הודעה אוטומטית<br>
                <span style="opacity: 0.5; margin-top: 5px; display: inline-block;">&copy; {{currentYear}} {{systemAppName}}</span>
            </p>
        </div>
    </div>
</body>
</html>`;

    return {
        welcomeSubject,
        welcomeHtml,
        welcomePlaceholderLegend: WELCOME_PLACEHOLDER_HELP,
        /** Legacy single-paragraph intro (used only if welcomeHtml is empty) */
        welcomeIntro: `אנחנו שמחים שהצטרפת למערכת ${app}! החשבון שלך נוצר בהצלחה.`,
        expiryIntro: 'תוקף המנוי למערכת הוא עד תאריך שיוצג במייל (נקבע אוטומטית לפי חשבון העסק).',
        graceIntro: 'תוקף המנוי שלך פג בתאריך שיוצג במייל (נקבע אוטומטית לפי חשבון העסק).',
        blockedIntro: 'הגישה למערכת נעצרה עקב פקיעת מנוי / חוב. לאחר עדכון התשלום תוכל לחזור לפעילות רגילה.',
        paymentSuccessIntro: 'שמחים לעדכן כי התשלום החודשי עבור המנוי בוצע בהצלחה.'
    };
}

/** @deprecated name — use buildWelcomeEmailDefaults */
function getEmailTemplatePlainDefaults(appName) {
    return buildWelcomeEmailDefaults(appName);
}

module.exports = {
    SECTORS,
    DEFAULT_JEWISH_HOLIDAYS,
    ISLAMIC_STATUTORY_HOLIDAYS_IL,
    getEmbeddedDefaultHolidaysBySector,
    mergeDefaultHolidaysBySector,
    getEmailTemplatePlainDefaults,
    buildWelcomeEmailDefaults,
    applyEmailPlaceholders,
    escapeHtmlAttr
};
