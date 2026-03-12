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
        if (this.jetserverUrl && this.jetserverUrl.startsWith('http')) {
            console.log(`[Email] Primary Provider Configured: JetServer SMTP Proxy`);
        } else {
            console.log(`[Email] JetServer Proxy not configured. Using GAS Relay as primary engine.`);
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
        if (this.jetserverUrl && this.jetserverUrl.startsWith('http')) {
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

    // Helper for consistent styling (Compact Version)
    getStyledTemplate(title, content, footerText = '', logoUrl = null, businessName = null) {
        const logoHtml = logoUrl ? `<img src="${logoUrl}" alt="Logo" style="max-height: 40px; margin-bottom: 8px; border-radius: 6px;">` : '';
        const displayBusinessName = businessName || config.APP_NAME;

        return `
            <div dir="rtl" style="font-family: 'Rubik', 'Inter', 'Segoe UI', sans-serif; background-color: #0f172a; margin: 0; padding: 10px 5px; color: #ffffff;">
                <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet">
                <div style="max-width: 450px; margin: 0 auto; background-color: #1e293b; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5); border: 1px solid rgba(255, 255, 255, 0.05);">
                    
                    <!-- Header -->
                    <div style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); padding: 15px; text-align: center;">
                        ${logoHtml}
                        <h1 style="color: #ffffff; margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -0.5px;">${displayBusinessName}</h1>
                    </div>

                    <!-- Content -->
                    <div style="padding: 15px; color: #e2e8f0; font-size: 14px; line-height: 1.4; text-align: right;">
                        <h2 style="color: #ffffff; margin-top: 0; margin-bottom: 12px; font-size: 18px; font-weight: 700; text-align: center;">${title}</h2>
                        <div style="background: rgba(0, 0, 0, 0.15); border-radius: 10px; padding: 15px; border: 1px solid rgba(255, 255, 255, 0.05); text-align: right;">
                            ${content}
                        </div>
                    </div>

                    <!-- Footer -->
                    <div style="background-color: rgba(15, 23, 42, 0.5); padding: 12px; text-align: center; border-top: 1px solid rgba(255, 255, 255, 0.05);">
                        <p style="margin: 0; color: #64748b; font-size: 11px; font-weight: 500;">
                            ${footerText || 'מערכת ' + config.APP_NAME + ' - הודעה אוטומטית'}
                            <br>
                            <span style="display: inline-block; margin-top: 4px; opacity: 0.5;">&copy; ${new Date().getFullYear()} ${config.APP_NAME}</span>
                        </p>
                    </div>
                </div>
            </div>
        `;
    }

    async sendRecoveryEmail(to, newPassword) {
        const title = 'שחזור סיסמה';
        const content = `
            <p style="text-align: right; margin-bottom: 15px;">שלום,</p>
            <p style="text-align: right;">התקבלה בקשה לאיפוס הסיסמה עבור חשבון המנהל שלך.</p>
            
            <div style="background: rgba(168, 85, 247, 0.1); border-right: 4px solid #a855f7; padding: 20px; margin: 20px 0; border-radius: 8px; text-align: center;">
                <p style="margin: 0; color: #a855f7; font-weight: 700; font-size: 13px; text-transform: uppercase;">הסיסמה החדשה שלך היא:</p>
                <p style="margin: 10px 0 0 0; font-family: 'Courier New', monospace; font-size: 32px; color: #ffffff; letter-spacing: 4px; font-weight: 800;">${newPassword}</p>
            </div>
            
            <p style="text-align: right; font-size: 13px; color: #94a3b8;">מומלץ לשנות את הסיסמה לאחר ההתחברות הראשונית.</p>
            
            <div style="text-align: center; margin-top: 25px;">
                <a href="${config.APP_URL || '#'}" style="display: inline-block; background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 10px; font-weight: 700; font-size: 15px;">חזרה למערכת</a>
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
                        breakdownHtml += `<div style="font-size: 11px; margin-bottom: 1px;">
                            <span style="font-weight: 700; color: #818cf8;">${rate}%:</span> ${hours}ש'
                        </div>`;
                    }

                    tableRows += `
                        <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                            <td style="padding: 10px 5px; font-weight: 700; color: #ffffff; font-size: 13px;">${employee}</td>
                            <td style="padding: 10px 5px; text-align: center; color: #94a3b8; font-size: 13px;">${shifts.length}</td>
                            <td style="padding: 10px 5px; text-align: center; color: #10b981; font-weight: 800; font-size: 13px;">${wageResult.totalHours}</td>
                            <td style="padding: 10px 5px; text-align: right; direction: rtl;">${breakdownHtml}</td>
                        </tr>
                    `;
                } catch (calcErr) {
                    console.error(`[EmailService] Salary breakdown failed for ${employee}:`, calcErr.message);
                    let totalHours = 0;
                    shifts.forEach(s => { if (s.start && s.end) totalHours += (new Date(s.end) - new Date(s.start)) / 3600000; });
                    tableRows += `
                        <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                            <td style="padding: 10px 5px; color: #ffffff; font-size: 13px;">${employee}</td>
                            <td style="padding: 10px 5px; text-align: center; color: #94a3b8; font-size: 13px;">${shifts.length}</td>
                            <td style="padding: 10px 5px; text-align: center; color: #ffffff; font-size: 13px;">${totalHours.toFixed(2)}</td>
                            <td style="padding: 10px 5px; text-align: right; color: #f43f5e; font-size: 11px;">שגיאה</td>
                        </tr>
                    `;
                }
            }
        } catch (globalErr) {
            console.error(`[EmailService] Monthly report table generation failed:`, globalErr.message);
            tableRows = '<tr><td colspan="4" style="color:#f43f5e; text-align:center; padding: 15px;">שגיאה ביצירת הטבלה</td></tr>';
        }

        const content = `
            <div style="background: rgba(0, 0, 0, 0.1); border-radius: 10px; overflow: hidden;">
                <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                    <thead>
                        <tr style="background-color: rgba(255, 255, 255, 0.03); color: #94a3b8;">
                            <th style="padding: 12px 5px; text-align: right; font-weight: 700;">עובד</th>
                            <th style="padding: 12px 5px; text-align: center; font-weight: 700;">משמ'</th>
                            <th style="padding: 12px 5px; text-align: center; font-weight: 700;">סה"כ</th>
                            <th style="padding: 12px 5px; text-align: right; font-weight: 700;">פירוט</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows || '<tr><td colspan="4" style="padding:20px; text-align:center; color: #64748b;">אין נתונים</td></tr>'}
                    </tbody>
                </table>
            </div>
            <p style="margin-top: 20px; color: #94a3b8; font-size: 12px; text-align: center; font-style: italic;">לדוח מפורט, היכנס למערכת הניהול.</p>
        `;

        return this.sendEmail(to, title + ` - ${businessName}`, this.getStyledTemplate(title, content, '', logoUrl, businessName));
    }

    async sendShiftAlert(to, employeeName, action, time, location, businessName, extraNote = '', logoUrl = null, summary = null) {
        let actionText = 'עדכון משמרת';
        let color = '#94a3b8';

        const isForced = action === 'FORCE_OUT' || action === 'ALERT_MAX';

        if (action === 'IN') { actionText = 'כניסה למשמרת'; color = '#10b981'; }
        else if (action === 'OUT') { actionText = 'יציאה ממשמרת'; color = '#f43f5e'; }
        else if (action === 'FORCE_OUT') { actionText = 'הוצאה אוטומטית'; color = '#f59e0b'; }
        else if (action === 'ALERT_MAX') { actionText = 'התראת חריגה'; color = '#fbbf24'; }

        // Smart location styling
        let locationHtml = '';
        if (action !== 'FORCE_OUT') {
            let locColor = '#ffffff';
            let locSuffix = '';
            const locationStr = String(location);

            if (locationStr.includes('בתוך המשרד') || locationStr.includes('בטווח המורשה') || locationStr.includes('בטווח')) {
                locColor = '#3b82f6';
                if (!locationStr.includes('(')) {
                    locSuffix = ' <span style="font-size: 11px; opacity: 0.8;">(בטווח המותר)</span>';
                }
            } else if (locationStr.includes('מהמשרד')) {
                locColor = '#f43f5e';
            }

            locationHtml = `
                <tr>
                    <td style="padding: 6px 0; color: #94a3b8; font-size: 13px; text-align: right;">מיקום:</td>
                    <td style="padding: 6px 0; color: ${locColor}; font-weight: 700; text-align: right; font-size: 13px;">${location || 'לא צוין'}${locSuffix}</td>
                </tr>
            `;
        }

        // Summary Statistics (if provided)
        let summaryHtml = '';
        if (summary) {
            let breakdownRows = '';
            if (summary.breakdown) {
                for (const [rate, hours] of Object.entries(summary.breakdown)) {
                    breakdownRows += `
                        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255, 255, 255, 0.05); padding: 4px 0;">
                            <span style="color: #94a3b8; font-size: 12px;">תעריף ${rate}%:</span>
                            <span style="color: #ffffff; font-weight: 600; font-size: 12px;">${hours} שעות</span>
                        </div>
                    `;
                }
            }

            summaryHtml = `
                <div style="margin-top: 20px; background: rgba(99, 102, 241, 0.05); border: 1px solid rgba(99, 102, 241, 0.2); border-radius: 12px; padding: 15px;">
                    <h3 style="margin: 0 0 12px 0; font-size: 14px; color: #818cf8; border-bottom: 1px solid rgba(129, 140, 248, 0.2); padding-bottom: 8px;">סיכום משמרת</h3>
                    
                    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                        <span style="color: #94a3b8; font-size: 13px;">זמן כולל:</span>
                        <span style="color: #ffffff; font-weight: 700; font-size: 13px;">${summary.duration || '-'}</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                        <span style="color: #94a3b8; font-size: 13px;">שעות לתשלום:</span>
                        <span style="color: #10b981; font-weight: 800; font-size: 14px;">${summary.weightedHours || '-'} ש'</span>
                    </div>

                    <div style="background: rgba(0, 0, 0, 0.2); border-radius: 8px; padding: 10px;">
                        ${breakdownRows}
                    </div>
                </div>
            `;
        }

        const content = `
            <div style="text-align: center; margin-bottom: 20px;">
                <div style="display: inline-block; padding: 6px 16px; background-color: ${color}15; color: ${color}; border: 1px solid ${color}30; border-radius: 50px; font-weight: 800; font-size: 13px; text-transform: uppercase;">
                    ${actionText}
                </div>
            </div>
            
            <div style="background: rgba(0, 0, 0, 0.1); padding: 15px; border-radius: 12px;">
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 8px 0; color: #94a3b8; font-size: 13px; text-align: right;">עובד:</td>
                        <td style="padding: 8px 0; color: #ffffff; font-weight: 700; text-align: right; font-size: 15px;">${employeeName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #94a3b8; font-size: 13px; text-align: right;">שעה:</td>
                        <td style="padding: 8px 0; color: #ffffff; text-align: right; font-weight: 600; font-size: 15px;">${new Date(time).toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' })}</td>
                    </tr>
                    ${locationHtml}
                    ${extraNote ? `
                    <tr>
                        <td colspan="2" style="padding-top: 15px;">
                            <div style="background: ${isForced ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255, 255, 255, 0.03)'}; 
                                        border: 1px solid ${isForced ? 'rgba(245, 158, 11, 0.3)' : 'rgba(255, 255, 255, 0.1)'}; 
                                        padding: 12px; border-radius: 8px; color: ${isForced ? '#f59e0b' : '#e2e8f0'}; 
                                        font-size: 13px; font-weight: ${isForced ? '700' : '400'}; text-align: center;">
                                ${extraNote}
                            </div>
                        </td>
                    </tr>
                    ` : ''}
                </table>
                ${summaryHtml}
            </div>
        `;

        return this.sendEmail(to, `התראה: ${actionText} - ${employeeName}`, this.getStyledTemplate(actionText, content, 'התראת מערכת נוכחות חכמה', logoUrl, businessName));
    }

    async sendSubscriptionAlert(to, businessName, daysLeft, expiryDate, logoUrl = null) {
        let title = `המנוי מסתיים בעוד ${daysLeft} ימים`;
        let color = '#f59e0b';

        if (daysLeft <= 0) {
            title = `המנוי הסתיים!`;
            color = '#f43f5e';
        }

        const formattedDate = new Date(expiryDate).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

        const content = `
            <div style="text-align: center; margin-bottom: 20px;">
                 <div style="display: inline-block; padding: 10px 20px; background-color: ${color}15; color: ${color}; border: 1px solid ${color}30; border-radius: 50px; font-weight: 800; font-size: 16px;">
                    ${title}
                 </div>
            </div>

            <p style="text-align: right; color: #ffffff; font-size: 15px; margin-bottom: 15px;">שלום <strong>${businessName}</strong>,</p>
            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">תוקף המנוי למערכת הוא עד: <strong style="color: #ffffff;">${formattedDate}</strong>.</p>
            
            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">אנא דאג לחדש את המנוי בהקדם להמשך פעילות רציפה.</p>

            <div style="text-align: center; margin-top: 30px;">
                <a href="${config.APP_URL || '#'}" style="display: inline-block; background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 14px 35px; border-radius: 12px; font-weight: 800; font-size: 16px;">חידוש מנוי עכשיו</a>
            </div>
        `;

        return this.sendEmail(to, `התראת מנוי - ${businessName}`, this.getStyledTemplate('סטטוס מנוי', content, '', logoUrl, businessName));
    }

    async sendPaymentSuccessNotification(to, data) {
        const title = 'תשלום בוצע בהצלחה';
        const content = `
            <p style="text-align: right; color: #ffffff; font-size: 15px; margin-bottom: 15px;">שלום <strong>${data.businessName}</strong>,</p>
            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">שמחים לעדכן כי התשלום החודשי עבור המנוי בוצע בהצלחה.</p>
            
            <div style="background: rgba(16, 185, 129, 0.1); border-right: 4px solid #10b981; padding: 15px; margin: 20px 0; border-radius: 8px;">
                <table style="width: 100%; color: #ffffff; font-size: 14px;">
                    <tr><td style="color: #94a3b8; text-align: right;">סכום לחיוב:</td><td style="text-align: left; font-weight: 700;">₪${data.amount}</td></tr>
                    <tr><td style="color: #94a3b8; text-align: right;">עובדים פעילים:</td><td style="text-align: left;">${data.activeEmployees}</td></tr>
                    <tr><td style="color: #94a3b8; text-align: right;">תוקף מנוי חדש:</td><td style="text-align: left; font-weight: 700;">${data.newExpiry}</td></tr>
                </table>
            </div>
            
            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 13px;">החשבונית תישלח אליך בנפרד ע"י חברת הסליקה.</p>
        `;
        return this.sendEmail(to, `אישור תשלום - ${data.businessName}`, this.getStyledTemplate(title, content, '', null, data.businessName));
    }

    async sendPaymentFailedNotification(to, data) {
        const title = 'חיוב המנוי נכשל';
        const content = `
            <p style="text-align: right; color: #ffffff; font-size: 15px; margin-bottom: 15px;">שלום <strong>${data.businessName}</strong>,</p>
            <p style="text-align: right; color: #f43f5e; line-height: 1.6; font-size: 14px; font-weight: 700;">ניסיון החיוב האוטומטי עבור המנוי נכשל.</p>
            
            <div style="background: rgba(244, 63, 94, 0.1); border-right: 4px solid #f43f5e; padding: 15px; margin: 20px 0; border-radius: 8px;">
                <p style="margin: 0; color: #ffffff; font-size: 14px;"><strong>סיבת הדחייה:</strong> ${data.error}</p>
                <p style="margin: 10px 0 0 0; color: #94a3b8; font-size: 13px;">סכום לחיוב: ₪${data.amount}</p>
            </div>
            
            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">אנא היכנס למערכת ועדכן את פרטי התשלום בהקדם כדי למנוע את השבתת השירות.</p>
            
            <div style="text-align: center; margin-top: 25px;">
                <a href="${config.APP_URL || '#'}" style="display: inline-block; background: #f43f5e; color: #ffffff; text-decoration: none; padding: 12px 30px; border-radius: 10px; font-weight: 700; font-size: 15px;">עדכון פרטי תשלום</a>
            </div>
        `;
        return this.sendEmail(to, `דחיית תשלום - ${data.businessName}`, this.getStyledTemplate(title, content, '', null, data.businessName));
    }

}

module.exports = new EmailService();
