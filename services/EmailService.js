const nodemailer = require('nodemailer');
const axios = require('axios');
const config = require('../config');

class EmailService {
    constructor() {
        this.gasUrl = config.GAS_COLD_STORAGE_URL;
        this.queue = [];
        this.isWorkerRunning = false;

        // Initialize SMTP Transporter if configured
        this.transporter = null;
        if (config.SMTP.HOST && config.SMTP.USER && config.SMTP.PASS) {
            const isSecure = String(config.SMTP.PORT) === '465';
            this.transporter = nodemailer.createTransport({
                host: config.SMTP.HOST,
                port: parseInt(config.SMTP.PORT) || 587,
                secure: isSecure, // true for 465, false for other ports
                auth: {
                    user: config.SMTP.USER,
                    pass: config.SMTP.PASS
                },
                tls: {
                    rejectUnauthorized: false // Helps bypass some cloud provider strict SSL blocks
                },
                connectionTimeout: 10000, // 10 seconds (fail fast to fallback)
                greetingTimeout: 5000
            });
            console.log(`[Email] SMTP Provider configured: ${config.SMTP.HOST}:${config.SMTP.PORT} (Secure: ${isSecure})`);
        } else {
            console.log('[Email] No SMTP configured. Using GAS Relay as primary engine.');
        }

        if (!this.gasUrl && !this.transporter) {
            console.error('[Email] ⚠️  No email provider (SMTP or GAS) configured! Emails will fail.');
        }

        this.startWorker();
    }

    startWorker() {
        if (this.isWorkerRunning) return;
        this.isWorkerRunning = true;
        this.isProcessing = false;
        console.log('[Email] Background Worker Started');

        setInterval(async () => {
            if (this.queue.length === 0 || this.isProcessing) return;

            const item = this.queue[0];
            const now = Date.now();
            if (item.nextRetry > now) return;

            this.isProcessing = true;
            try {
                const success = await this.processEmail(item);
                if (success) {
                    this.queue.shift();
                } else {
                    item.retries++;
                    if (item.retries >= 5) {
                        console.error(`[Email] Failed after 5 attempts to ${item.to}. Dropping.`);
                        this.queue.shift();
                    } else {
                        const delay = 5000 * Math.pow(2, item.retries - 1);
                        item.nextRetry = now + delay;
                        console.log(`[Email] Retry #${item.retries} for ${item.to} in ${delay}ms`);
                    }
                }
            } catch (e) {
                console.error(`[Email] Worker Error: ${e.message}`);
                item.retries++;
                item.nextRetry = now + 5000;
            } finally {
                this.isProcessing = false;
            }
        }, 2000);
    }

    addToQueue(to, subject, html, attachments = [], name = null) {
        this.queue.push({ to, subject, html, attachments, name, retries: 0, nextRetry: Date.now() });
        console.log(`[Email] Queued. Size: ${this.queue.length}`);
    }

    async sendEmail(to, subject, html, attachments = [], name = null) {
        this.addToQueue(to, subject, html, attachments, name || config.APP_NAME);
        return { success: true, message: 'Queued' };
    }

    async processEmail(item) {
        // PRIORITY 1: SMTP
        if (this.transporter) {
            try {
                const info = await this.transporter.sendMail({
                    from: `"${item.name || config.APP_NAME}" <${config.SMTP.FROM}>`,
                    to: item.to,
                    subject: item.subject,
                    html: item.html
                });
                console.log(`[Email] Sent via SMTP to ${item.to}: ${info.messageId}`);
                return true;
            } catch (error) {
                console.error(`[Email] SMTP Fail: ${error.message}. Trying GAS fallback...`);
                // Fall through to GAS
            }
        }

        // PRIORITY 2: GAS Fallback
        if (this.gasUrl) {
            try {
                const emailData = {
                    action: 'sendEmail',
                    to: item.to,
                    subject: item.subject,
                    html: item.html,
                    name: item.name || config.APP_NAME
                };

                const response = await axios.post(this.gasUrl, emailData, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 15000,
                    maxRedirects: 5
                });

                let isSuccess = false;
                if (response.data) {
                    if (typeof response.data === 'object' && response.data.success) isSuccess = true;
                    else if (typeof response.data === 'string' && response.data.includes('"success":true')) isSuccess = true;
                    else if (response.status === 200) isSuccess = true;
                }

                if (isSuccess) {
                    console.log(`[Email] Sent via GAS to ${item.to}`);
                    return true;
                }
            } catch (error) {
                console.error(`[Email] GAS Fail: ${error.message}`);
            }
        }

        return false;
    }

    // Helper for consistent styling
    getStyledTemplate(title, content, footerText = '') {
        return `
            <div dir="rtl" style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; margin: 0; padding: 40px 20px;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
                    
                    <!-- Header -->
                    <div style="background-color: #2563eb; padding: 20px; text-align: center;">
                        <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600;">${config.APP_NAME}</h1>
                    </div>

                    <!-- Content -->
                    <div style="padding: 30px; color: #374151; font-size: 16px; line-height: 1.6;">
                        <h2 style="color: #111827; margin-top: 0; margin-bottom: 20px; font-size: 20px; font-weight: 600; text-align: center;">${title}</h2>
                        ${content}
                    </div>

                    <!-- Footer -->
                    <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
                        <p style="margin: 0; color: #6b7280; font-size: 12px;">
                            ${footerText || 'הודעה זו נשלחה אוטומטית ממערכת ' + config.APP_NAME}
                            <br>
                            &copy; ${new Date().getFullYear()} כל הזכויות שמורות.
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    async sendRecoveryEmail(to, newPassword) {
        const title = 'שחזור סיסמה';
        const content = `
            <p>שלום,</p>
            <p>התקבלה בקשה לאיפוס הסיסמה עבור חשבון המנהל שלך.</p>
            
            <div style="background-color: #eff6ff; border-right: 4px solid #3b82f6; padding: 20px; margin: 25px 0; border-radius: 4px;">
                <p style="margin: 0; color: #1e40af; font-weight: bold; font-size: 14px;">הסיסמה החדשה שלך היא:</p>
                <p style="margin: 10px 0 0 0; font-family: monospace; font-size: 28px; color: #2563eb; letter-spacing: 3px; font-weight: bold;">${newPassword}</p>
            </div>
            
            <p>מומלץ לשנות את הסיסמה לאחר ההתחברות הראשונית למערכת.</p>
            
            <div style="text-align: center; margin-top: 30px;">
                <a href="https://tempusgeo.onrender.com" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: 600;">חזרה למערכת</a>
            </div>
        `;

        return this.sendEmail(to, `איפוס סיסמה - ${config.APP_NAME}`, this.getStyledTemplate(title, content));
    }

    async sendMonthlyReport(to, reportData, year, month, businessName) {
        const title = `דוח שעות חודשי: ${month}/${year}`;

        // Construct HTML Table
        let tableRows = '';
        for (const [employee, shifts] of Object.entries(reportData)) {
            let totalHours = 0;
            shifts.forEach(s => {
                if (s.start && s.end) {
                    totalHours += (new Date(s.end) - new Date(s.start)) / 3600000;
                }
            });
            tableRows += `
                <tr style="border-bottom: 1px solid #e5e7eb;">
                    <td style="padding: 12px;">${employee}</td>
                    <td style="padding: 12px; text-align: center;">${shifts.length}</td>
                    <td style="padding: 12px; text-align: center;">${totalHours.toFixed(2)}</td>
                </tr>
            `;
        }

        const content = `
            <h3 style="color: #4b5563; text-align: center; margin-top: -10px; margin-bottom: 25px;">${businessName}</h3>
            
            <div style="overflow-x: auto;">
                <table style="width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px;">
                    <thead>
                        <tr style="background-color: #f3f4f6; color: #374151;">
                            <th style="padding: 12px; text-align: right; border-bottom: 2px solid #e5e7eb;">עובד</th>
                            <th style="padding: 12px; text-align: center; border-bottom: 2px solid #e5e7eb;">משמרות</th>
                            <th style="padding: 12px; text-align: center; border-bottom: 2px solid #e5e7eb;">סה"כ שעות</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows || '<tr><td colspan="3" style="padding:20px; text-align:center; color: #6b7280;">אין נתונים לחודש זה</td></tr>'}
                    </tbody>
                </table>
            </div>

            <p style="margin-top: 25px; color: #6b7280; font-size: 14px; text-align: center;">לדוח מפורט והורדת נתונים, היכנס למערכת הניהול.</p>
        `;

        return this.sendEmail(to, title + ` - ${businessName}`, this.getStyledTemplate(title, content));
    }

    async sendShiftAlert(to, employeeName, action, time, location, businessName, extraNote = '') {
        let actionText = 'עדכון משמרת';
        let color = '#64748b'; // Gray default

        if (action === 'IN') { actionText = 'כניסה למשמרת'; color = '#10b981'; }
        else if (action === 'OUT') { actionText = 'יציאה ממשמרת'; color = '#ef4444'; }
        else if (action === 'FORCE_OUT') { actionText = 'הוצאה אוטומטית (חריגת זמן)'; color = '#f97316'; } // Orange
        else if (action === 'ALERT_MAX') { actionText = 'התראת חריגה מזמן משמרת מירבי'; color = '#eab308'; } // Yellow

        const content = `
            <div style="text-align: center; margin-bottom: 10px;">
                <span style="display: inline-block; padding: 6px 16px; background-color: ${color}20; color: ${color}; border-radius: 9999px; font-weight: 700; font-size: 14px;">${actionText}</span>
            </div>
            
            <h3 style="color: #4b5563; text-align: center; margin-top: 5px; margin-bottom: 25px;">${businessName}</h3>

            <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; border: 1px solid #e2e8f0;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 8px 0; color: #64748b; font-weight: 500;">עובד:</td>
                        <td style="padding: 8px 0; color: #1e293b; font-weight: 600; text-align: left;">${employeeName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #64748b; font-weight: 500;">שעה:</td>
                        <td style="padding: 8px 0; color: #1e293b; text-align: left;">${new Date(time).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })}</td>
                    </tr>
                    ${extraNote ? `
                    <tr>
                        <td style="padding: 8px 0; color: #ef4444; font-weight: 500;">הערה:</td>
                        <td style="padding: 8px 0; color: #ef4444; font-weight: 600; text-align: left;">${extraNote}</td>
                    </tr>
                    ` : ''}
                    <tr>
                        <td style="padding: 8px 0; color: #64748b; font-weight: 500;">מיקום:</td>
                        <td style="padding: 8px 0; color: #1e293b; text-align: left;">${location || 'לא צוין'}</td>
                    </tr>
                </table>
            </div>
        `;

        return this.sendEmail(to, `התראה: ${actionText} - ${employeeName}`, this.getStyledTemplate(actionText, content, 'הודעה זו נשלחה כי מוגדרת קבלת התראות בפרופיל החברה'));
    }

    async sendSubscriptionAlert(to, businessName, daysLeft, expiryDate) {
        let title = `המנוי שלך מסתיים בעוד ${daysLeft} ימים`;
        let color = '#f59e0b'; // Orange

        if (daysLeft <= 0) {
            title = `המנוי שלך הסתיים!`;
            color = '#ef4444'; // Red
        }

        const formattedDate = new Date(expiryDate).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

        const content = `
            <div style="text-align: center; margin-bottom: 20px;">
                 <span style="display: inline-block; padding: 8px 20px; background-color: ${color}20; color: ${color}; border-radius: 8px; font-weight: 700; font-size: 18px;">${title}</span>
            </div>

            <p>שלום <strong>${businessName}</strong>,</p>
            <p>תוקף המנוי שלך למערכת TempusGeo הוא עד: <strong>${formattedDate}</strong>.</p>
            
            <p>כדי להבטיח את המשך פעילות המערכת ושמירת הנתונים, אנא דאג לחדש את המנוי בהקדם.</p>

            <div style="text-align: center; margin-top: 35px;">
                <a href="https://tempusgeo.onrender.com" style="display: inline-block; background-color: ${color}; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: 700; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">חידוש מנוי</a>
            </div>
        `;

        return this.sendEmail(to, `התראת מנוי - ${businessName}`, this.getStyledTemplate('סטטוס מנוי', content));
    }
}

module.exports = new EmailService();
