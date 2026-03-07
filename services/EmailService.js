const nodemailer = require('nodemailer');
const axios = require('axios');
const config = require('../config');

class EmailService {
    constructor() {
        this.gasUrl = config.GAS_COLD_STORAGE_URL;
        this.queue = [];
        this.isWorkerRunning = false;

        // Initialize JetServer Mail Proxy configuration
        this.jetserverUrl = config.JETSERVER_MAIL_URL;
        this.jetserverSecret = config.JETSERVER_MAIL_SECRET;

        // Try to identify if we are configured to use Jetserver
        if (this.jetserverUrl && !this.jetserverUrl.includes('your-domain.com') && this.jetserverUrl.startsWith('http')) {
            console.log(`[Email] Primary Provider Configured: JetServer SMTP Proxy (${this.jetserverUrl})`);
        } else {
            console.log(`[Email] JetServer Proxy not configured or invalid URL. Using GAS Relay as primary engine.`);
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
        // PRIORITY 1: JetServer SMTP Proxy
        if (this.jetserverUrl && !this.jetserverUrl.includes('your-domain.com')) {
            try {
                const response = await axios.post(this.jetserverUrl, {
                    secret: this.jetserverSecret,
                    to: item.to,
                    subject: item.subject,
                    html: item.html,
                    name: item.name || config.APP_NAME,
                    smtp_host: config.SMTP.HOST,
                    smtp_port: config.SMTP.PORT,
                    smtp_user: config.SMTP.USER,
                    smtp_pass: config.SMTP.PASS
                }, { timeout: 15000 });

                if (response.data && response.data.success) {
                    console.log(`[Email] Sent via JetServer SMTP Proxy to ${item.to}`);
                    return true;
                } else {
                    console.error(`[Email] JetServer Proxy Fail: ${response.data.error || 'Unknown error'}. Trying GAS fallback...`);
                }
            } catch (error) {
                console.error(`[Email] JetServer Proxy Request Error: ${error.message}. Trying GAS fallback...`);
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
    getStyledTemplate(title, content, footerText = '', logoUrl = null) {
        const logoHtml = logoUrl ? `<img src="${logoUrl}" alt="Logo" style="max-height: 60px; margin-bottom: 15px; border-radius: 8px;">` : '';

        return `
            <div dir="rtl" style="font-family: 'Rubik', 'Inter', 'Segoe UI', sans-serif; background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); margin: 0; padding: 40px 20px; color: #ffffff;">
                <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet">
                <div style="max-width: 600px; margin: 0 auto; background-color: #1a1a2e; border-radius: 20px; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3), 0 10px 10px -5px rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.1);">
                    
                    <!-- Header -->
                    <div style="background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); padding: 30px 20px; text-align: center;">
                        ${logoHtml}
                        <h1 style="color: #ffffff; margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.5px; text-shadow: 0 2px 4px rgba(0,0,0,0.2);">${config.APP_NAME}</h1>
                    </div>

                    <!-- Content -->
                    <div style="padding: 40px; color: #e2e8f0; font-size: 16px; line-height: 1.6;">
                        <h2 style="color: #ffffff; margin-top: 0; margin-bottom: 25px; font-size: 22px; font-weight: 700; text-align: center;">${title}</h2>
                        <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 15px; padding: 25px;">
                            ${content}
                        </div>
                    </div>

                    <!-- Footer -->
                    <div style="background-color: rgba(0, 0, 0, 0.2); padding: 25px; text-align: center; border-top: 1px solid rgba(255, 255, 255, 0.05);">
                        <p style="margin: 0; color: #94a3b8; font-size: 13px; font-weight: 500;">
                            ${footerText || 'הודעה זו נשלחה אוטומטית ממערכת ' + config.APP_NAME}
                            <br>
                            <span style="display: inline-block; margin-top: 8px; opacity: 0.7;">&copy; ${new Date().getFullYear()} כל הזכויות שמורות.</span>
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    async sendRecoveryEmail(to, newPassword) {
        const title = 'שחזור סיסמה';
        const content = `
            <p style="text-align: right;">שלום,</p>
            <p style="text-align: right;">התקבלה בקשה לאיפוס הסיסמה עבור חשבון המנהל שלך.</p>
            
            <div style="background: linear-gradient(135deg, rgba(99, 102, 241, 0.1) 0%, rgba(168, 85, 247, 0.1) 100%); border-right: 4px solid #a855f7; padding: 25px; margin: 25px 0; border-radius: 12px; text-align: center;">
                <p style="margin: 0; color: #a855f7; font-weight: 700; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">הסיסמה החדשה שלך היא:</p>
                <p style="margin: 15px 0 0 0; font-family: 'Courier New', monospace; font-size: 36px; color: #ffffff; letter-spacing: 5px; font-weight: 800; text-shadow: 0 0 20px rgba(168, 85, 247, 0.4);">${newPassword}</p>
            </div>
            
            <p style="text-align: right; font-size: 14px; color: #94a3b8;">מומלץ לשנות את הסיסמה לאחר ההתחברות הראשונית למערכת.</p>
            
            <div style="text-align: center; margin-top: 35px;">
                <a href="https://tempusgeo.onrender.com" style="display: inline-block; background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 15px 35px; border-radius: 12px; font-weight: 700; font-size: 16px; box-shadow: 0 10px 15px -3px rgba(99, 102, 241, 0.4); transition: transform 0.2s;">חזרה למערכת</a>
            </div>
        `;

        return this.sendEmail(to, `איפוס סיסמה - ${config.APP_NAME}`, this.getStyledTemplate(title, content));
    }

    async sendMonthlyReport(to, reportData, year, month, businessName, salaryConfig = {}, companyId, logoUrl = null) {
        const title = `דוח שעות חודשי: ${month}/${year}`;
        let tableRows = '';

        try {
            const WageCalculator = require('./WageCalculator');
            const dataManager = require('./DataManager');

            // Fetch holiday dates for this specific month/company
            let holidayDates = [];
            if (companyId) {
                try {
                    holidayDates = await dataManager.getHolidayDatesForMonth(companyId, year, month);
                } catch (err) {
                    console.error(`[EmailService] Failed to fetch holiday dates for ${companyId}:`, err.message);
                }
            }

            // Construct HTML Table
            for (const [employee, shifts] of Object.entries(reportData)) {
                try {
                    const wageResult = WageCalculator.calculateBreakdown(shifts, salaryConfig, holidayDates);

                    let breakdownHtml = '';
                    for (const [rate, hours] of Object.entries(wageResult.breakdown)) {
                        breakdownHtml += `<div style="font-size: 11px; margin-bottom: 2px;">
                            <span style="font-weight: 700; color: #6366f1;">${rate}%:</span> ${hours} שעות
                        </div>`;
                    }

                    tableRows += `
                        <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                            <td style="padding: 15px 10px; font-weight: 700; color: #ffffff;">${employee}</td>
                            <td style="padding: 15px 10px; text-align: center; color: #94a3b8;">${shifts.length}</td>
                            <td style="padding: 15px 10px; text-align: center; color: #10b981; font-weight: 800;">${wageResult.totalHours}</td>
                            <td style="padding: 15px 10px; text-align: right; direction: rtl;">${breakdownHtml}</td>
                        </tr>
                    `;
                } catch (calcErr) {
                    console.error(`[EmailService] Salary breakdown failed for ${employee}:`, calcErr.message);
                    // Minimal fallback for this row
                    let totalHours = 0;
                    shifts.forEach(s => { if (s.start && s.end) totalHours += (new Date(s.end) - new Date(s.start)) / 3600000; });
                    tableRows += `
                        <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                            <td style="padding: 15px 10px; color: #ffffff;">${employee}</td>
                            <td style="padding: 15px 10px; text-align: center; color: #94a3b8;">${shifts.length}</td>
                            <td style="padding: 15px 10px; text-align: center; color: #ffffff;">${totalHours.toFixed(2)}</td>
                            <td style="padding: 15px 10px; text-align: right; color: #f43f5e;">שגיאת חישוב</td>
                        </tr>
                    `;
                }
            }
        } catch (globalErr) {
            console.error(`[EmailService] Monthly report table generation failed:`, globalErr.message);
            tableRows = '<tr><td colspan="4" style="color:#f43f5e; text-align:center; padding: 20px;">שגיאה ביצירת הטבלה המפורטת</td></tr>';
        }

        const content = `
            <h3 style="color: #94a3b8; text-align: center; margin-top: 0; margin-bottom: 30px; font-size: 18px; font-weight: 500;">${businessName}</h3>
            
            <div style="background: rgba(0, 0, 0, 0.2); border-radius: 15px; border: 1px solid rgba(255, 255, 255, 0.05); overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead>
                        <tr style="background-color: rgba(255, 255, 255, 0.03); color: #94a3b8;">
                            <th style="padding: 15px 10px; text-align: right; border-bottom: 1px solid rgba(255, 255, 255, 0.1); font-weight: 700;">עובד</th>
                            <th style="padding: 15px 10px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, 0.1); font-weight: 700;">משמרות</th>
                            <th style="padding: 15px 10px; text-align: center; border-bottom: 1px solid rgba(255, 255, 255, 0.1); font-weight: 700;">סה"כ</th>
                            <th style="padding: 15px 10px; text-align: right; border-bottom: 1px solid rgba(255, 255, 255, 0.1); font-weight: 700;">פירוט שכר</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows || '<tr><td colspan="4" style="padding:30px; text-align:center; color: #64748b;">אין נתונים לחודש זה</td></tr>'}
                    </tbody>
                </table>
            </div>

            <p style="margin-top: 35px; color: #94a3b8; font-size: 14px; text-align: center; font-style: italic;">לדוח מפורט והורדת נתונים (Excel), היכנס למערכת הניהול.</p>
        `;

        return this.sendEmail(to, title + ` - ${businessName}`, this.getStyledTemplate(title, content, '', logoUrl));
    }

    async sendShiftAlert(to, employeeName, action, time, location, businessName, extraNote = '', logoUrl = null) {
        let actionText = 'עדכון משמרת';
        let color = '#94a3b8'; // Slate default

        if (action === 'IN') { actionText = 'כניסה למשמרת'; color = '#10b981'; }
        else if (action === 'OUT') { actionText = 'יציאה ממשמרת'; color = '#f43f5e'; }
        else if (action === 'FORCE_OUT') { actionText = 'הוצאה אוטומטית (חריגת זמן)'; color = '#f59e0b'; }
        else if (action === 'ALERT_MAX') { actionText = 'התראת חריגה מזמן משמרת'; color = '#fbbf24'; }

        const content = `
            <div style="text-align: center; margin-bottom: 25px;">
                <div style="display: inline-block; padding: 10px 24px; background-color: ${color}15; color: ${color}; border: 1px solid ${color}30; border-radius: 100px; font-weight: 800; font-size: 15px; letter-spacing: 0.5px; text-transform: uppercase;">
                    ${actionText}
                </div>
            </div>
            
            <h3 style="color: #94a3b8; text-align: center; margin-top: 0; margin-bottom: 30px; font-size: 18px; font-weight: 500;">${businessName}</h3>

            <div style="background: rgba(0, 0, 0, 0.2); padding: 30px; border-radius: 15px; border: 1px solid rgba(255, 255, 255, 0.05);">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 12px 0; color: #94a3b8; font-weight: 500; font-size: 14px;">עובד:</td>
                        <td style="padding: 12px 0; color: #ffffff; font-weight: 700; text-align: left; font-size: 16px;">${employeeName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 0; color: #94a3b8; font-weight: 500; font-size: 14px;">שעה:</td>
                        <td style="padding: 12px 0; color: #ffffff; text-align: left; font-weight: 600; font-size: 16px;">${new Date(time).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })}</td>
                    </tr>
                    <tr>
                        <td style="padding: 12px 0; color: #94a3b8; font-weight: 500; font-size: 14px;">מיקום:</td>
                        <td style="padding: 12px 0; color: ${(location && String(location).includes('מהמשרד')) ? '#f43f5e' : '#10b981'}; text-align: left; font-weight: 700; font-size: 16px;">${location || 'לא צוין'}</td>
                    </tr>
                    ${extraNote ? `
                    <tr>
                        <td colspan="2" style="padding-top: 20px;">
                            <div style="background: rgba(244, 63, 94, 0.1); border: 1px solid rgba(244, 63, 94, 0.2); padding: 15px; border-radius: 10px; color: #f43f5e; font-size: 14px; font-weight: 500; text-align: center;">
                                ${extraNote}
                            </div>
                        </td>
                    </tr>
                    ` : ''}
                </table>
            </div>
        `;

        return this.sendEmail(to, `התראה: ${actionText} - ${employeeName}`, this.getStyledTemplate(actionText, content, 'הודעה זו נשלחה כי מוגדרת קבלת התראות בפרופיל החברה', logoUrl));
    }

    async sendSubscriptionAlert(to, businessName, daysLeft, expiryDate, logoUrl = null) {
        let title = `המנוי שלך מסתיים בעוד ${daysLeft} ימים`;
        let color = '#f59e0b'; // Orange

        if (daysLeft <= 0) {
            title = `המנוי שלך הסתיים!`;
            color = '#f43f5e'; // Red
        }

        const formattedDate = new Date(expiryDate).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

        const content = `
            <div style="text-align: center; margin-bottom: 30px;">
                 <div style="display: inline-block; padding: 12px 28px; background-color: ${color}15; color: ${color}; border: 1px solid ${color}30; border-radius: 100px; font-weight: 800; font-size: 18px; letter-spacing: 0.5px;">
                    ${title}
                 </div>
            </div>

            <p style="text-align: right; color: #ffffff; font-size: 16px;">שלום <strong>${businessName}</strong>,</p>
            <p style="text-align: right; color: #94a3b8; line-height: 1.8;">תוקף המנוי שלך למערכת <strong>TempusGeo</strong> הוא עד בתאריך: <strong style="color: #ffffff;">${formattedDate}</strong>.</p>
            
            <p style="text-align: right; color: #94a3b8; line-height: 1.8;">כדי להבטיח את המשך פעילות המערכת ושמירת הנתונים של עובדיך, אנא דאג לחדש את המנוי בהקדם.</p>

            <div style="text-align: center; margin-top: 45px;">
                <a href="https://tempusgeo.onrender.com" style="display: inline-block; background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 16px 40px; border-radius: 12px; font-weight: 800; font-size: 18px; box-shadow: 0 10px 15px -3px rgba(99, 102, 241, 0.4);">חידוש מנוי עכשיו</a>
            </div>
        `;

        return this.sendEmail(to, `התראת מנוי - ${businessName}`, this.getStyledTemplate('סטטוס מנוי', content, '', logoUrl));
    }
}

module.exports = new EmailService();
