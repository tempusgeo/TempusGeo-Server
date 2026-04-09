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

        this.appName = config.APP_NAME;
        this.appLogoUrl = null;

        this.startWorker();
    }

    setSystemConfig(systemConfig) {
        if (!systemConfig) return;
        
        // Multi-tenant: EmailService should NOT store a single appName.
        // It should use the systemConfig passed here for GLOBAL system emails (recovery etc),
        // but for specific company emails, it should use the company ID to fetch config.
        
        if (systemConfig.appName !== undefined) {
            this.systemAppName = systemConfig.appName || config.APP_NAME;
            console.log(`[Email] System App Name updated to: ${this.systemAppName}`);
        }
        if (systemConfig.appLogoUrl !== undefined) {
            this.systemAppLogoUrl = systemConfig.appLogoUrl || null;
        }
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
        let finalName = name;

        // If no specific name provided, use the system name as fallback
        if (!finalName || finalName === config.APP_NAME || finalName === "TempusGeo") {
            finalName = this.systemAppName || config.APP_NAME;
        }

        this.addToQueue(to, subject, html, attachments, finalName);
        return { success: true, message: 'Queued' };
    }

    async processEmail(item) {
        let sentMethod = null;
        let finalName = item.name;
        if (!finalName || finalName === config.APP_NAME || finalName === "TempusGeo") {
            finalName = this.systemAppName || config.APP_NAME;
        }

        // PRIORITY 1: JetServer SMTP Proxy
        if (this.jetserverUrl && this.jetserverUrl.startsWith('http')) {
            try {
                const response = await axios.post(this.jetserverUrl, {
                    secret: this.jetserverSecret,
                    to: item.to,
                    subject: item.subject,
                    html: item.html,
                    name: finalName,
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
                // Ensure we get dynamic name if not provided or is default
                let finalName = item.name;
                if (!finalName || finalName === config.APP_NAME || finalName === "TempusGeo") {
                    finalName = this.systemAppName || config.APP_NAME;
                }

                const emailData = {
                    action: 'sendEmail',
                    to: item.to,
                    subject: item.subject,
                    html: item.html,
                    name: finalName
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
        const dataManager = require('./DataManager');
        const systemConfig = dataManager.getSystemConfigSync ? dataManager.getSystemConfigSync() : (this.systemAppName ? { appName: this.systemAppName, appLogoUrl: this.systemAppLogoUrl } : {});

        const finalLogo = logoUrl || systemConfig.appLogoUrl || this.systemAppLogoUrl || null;
        const logoHtml = finalLogo ? `<img src="${finalLogo}" alt="Logo" style="max-height: 40px; margin-bottom: 8px; border-radius: 6px;">` : '';
        const displayBusinessName = businessName || systemConfig.appName || this.systemAppName || config.APP_NAME;

        return `
            <!DOCTYPE html>
            <html dir="rtl" lang="he">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap" rel="stylesheet">
                <style>
                    body { margin: 0; padding: 0; }
                    @media only screen and (max-width: 600px) {
                        .main-container { width: 100% !important; border-radius: 0 !important; }
                        .table-wrapper { overflow-x: auto !important; }
                        table { min-width: 450px !important; }
                    }
                </style>
            </head>
            <body style="background-color: #0f172a; font-family: 'Rubik', sans-serif; color: #ffffff; padding: 10px 0;">
                <div class="main-container" style="max-width: 600px; margin: 0 auto; background-color: #1e293b; border-radius: 12px; overflow: hidden; border: 1px solid rgba(255, 255, 255, 0.05); box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);">
                    
                    <!-- Header -->
                    <div style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); padding: 20px 15px; text-align: center;">
                        ${logoHtml}
                        <h1 style="color: #ffffff; margin: 0; font-size: 22px; font-weight: 700;">${displayBusinessName}</h1>
                    </div>

                    <!-- Content -->
                    <div style="padding: 15px; text-align: right; direction: rtl;">
                        <h2 style="color: #ffffff; margin-top: 0; margin-bottom: 15px; font-size: 18px; font-weight: 700; text-align: center;">${title}</h2>
                        <div style="background: rgba(0, 0, 0, 0.15); border-radius: 10px; padding: 15px; border: 1px solid rgba(255, 255, 255, 0.05); direction: rtl; text-align: right;">
                            ${content}
                        </div>
                    </div>

                    <!-- Footer -->
                    <div style="background-color: rgba(15, 23, 42, 0.5); padding: 15px; text-align: center; border-top: 1px solid rgba(255, 255, 255, 0.05);">
                        <p style="margin: 0; color: #64748b; font-size: 12px;">
                            ${footerText || 'מערכת ' + (systemConfig.appName || config.APP_NAME) + ' - הודעה אוטומטית'}
                            <br>
                            <span style="opacity: 0.5; margin-top: 5px; display: block;">&copy; ${new Date().getFullYear()} ${systemConfig.appName || config.APP_NAME}</span>
                        </p>
                    </div>
                </div>
            </body>
            </html>
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

        const dataManager = require('./DataManager');
        const systemConfig = dataManager.getSystemConfigSync ? dataManager.getSystemConfigSync() : {};
        const appName = systemConfig.appName || config.APP_NAME;

        return this.sendEmail(to, `איפוס סיסמה - ${appName}`, this.getStyledTemplate(title, content));
    }

    async sendWelcomeEmail(to, businessName, companyId, password) {
        const title = 'ברוכים הבאים למערכת!';
        const dataManager = require('./DataManager');
        const systemConfig = dataManager.getSystemConfigSync ? dataManager.getSystemConfigSync() : {};
        const appName = systemConfig.appName || config.APP_NAME;

        // Defensive: log inputs to help debug if ever empty again
        console.log(`[Email] sendWelcomeEmail → to=${to} businessName=${businessName} companyId=${companyId} hasPassword=${!!password} appName=${appName}`);

        let html;
        try {
            // Use admin-configured intro if set, otherwise use default
            const templates = systemConfig.emailTemplates || {};
            const introHtml = templates.welcomeIntro
                ? `<p style="text-align: right; margin-bottom: 15px;">${templates.welcomeIntro.replace(/\n/g, '<br>')}</p>`
                : `<p style="text-align: right; margin-bottom: 15px;">אנחנו שמחים שהצטרפת למערכת <strong>${appName}</strong>! החשבון שלך נוצר בהצלחה.</p>`;

            const content = `
            <p style="text-align: right; margin-bottom: 15px;">שלום <strong>${businessName}</strong>,</p>
            ${introHtml}
            
            <div style="background: rgba(99, 102, 241, 0.1); border-right: 4px solid #6366f1; padding: 20px; margin: 20px 0; border-radius: 12px;">
                <h3 style="color: #ffffff; font-size: 16px; margin: 0 0 15px 0; text-align: right;">פרטי ההתחברות שלך:</h3>
                <table style="width: 100%; color: #ffffff; font-size: 14px;">
                    <tr>
                        <td style="color: #94a3b8; text-align: right; padding: 5px 0;">מספר עסק:</td>
                        <td style="text-align: left; font-weight: 700;">${companyId}</td>
                    </tr>
                    <tr>
                        <td style="color: #94a3b8; text-align: right; padding: 5px 0;">סיסמת מנהל:</td>
                        <td style="text-align: left; font-weight: 700;">${password}</td>
                    </tr>
                </table>
            </div>

            <p style="text-align: right; font-size: 14px; color: #94a3b8; line-height: 1.6;">
                כעת ניתן להתחבר ללוח הבקרה ולהתחיל לנהל את נוכחות העובדים שלך בקלות.
                <br>
                מומלץ לשנות את הסיסמה לאחר ההתחברות הראשונית באזור ההגדרות.
            </p>
            
            <div style="text-align: center; margin-top: 30px;">
                <a href="${config.APP_URL || '#'}" style="display: inline-block; background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 12px; font-weight: 800; font-size: 16px; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);">כניסה למערכת</a>
            </div>
        `;
            html = this.getStyledTemplate(title, content, '', null, businessName);
        } catch (templateErr) {
            console.error(`[Email] getStyledTemplate failed, using fallback HTML:`, templateErr.message);
            // Fallback: minimal but always includes the critical data
            html = `<!DOCTYPE html><html dir="rtl" lang="he"><body style="font-family:sans-serif;background:#0f172a;color:#fff;padding:20px;">
                <h2>ברוכים הבאים ל-${appName}!</h2>
                <p>שלום <strong>${businessName}</strong>, החשבון שלך נוצר בהצלחה.</p>
                <hr style="border-color:#334155;">
                <p><strong>מספר עסק:</strong> ${companyId}</p>
                <p><strong>סיסמת מנהל:</strong> ${password}</p>
                <hr style="border-color:#334155;">
                <p><a href="${config.APP_URL || '#'}" style="color:#818cf8;">כניסה למערכת</a></p>
            </body></html>`;
        }

        return this.sendEmail(to, `ברוכים הבאים ל-${appName} - ${businessName}`, html);
    }

    async sendMonthlyReport(to, reportData, year, month, businessName, salaryConfig = {}, companyId, logoUrl = null) {
        const title = `דוח שעות חודשי: ${month}/${year}`;
        let tableRows = '';

        try {
            const WageCalculator = require('./WageCalculator');
            const dataManager = require('./DataManager');

            const bizConfig = await dataManager.getCompanyConfig(companyId);

            // Construct HTML Table
            for (const [employee, shifts] of Object.entries(reportData)) {
                try {
                    const holidayDates = await dataManager.getHolidayDatesForMonth(companyId, year, month, employee);
                    const workWeekType = bizConfig.settings?.constraints?.[employee]?.workWeekType || '5day';
                    const wageResult = WageCalculator.calculateBreakdown(shifts, salaryConfig, holidayDates, workWeekType);

                    let breakdownHtml = '';
                    for (const [rate, hours] of Object.entries(wageResult.breakdown)) {
                        breakdownHtml += `<div style="font-size: 13px; margin-bottom: 1px;">
                            <span style="font-weight: 700; color: #818cf8;">${rate}%:</span> ${hours}ש'
                        </div>`;
                    }

                    tableRows += `
                        <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                            <td style="padding: 8px 4px; font-weight: 700; color: #ffffff; font-size: 13px;">${employee}</td>
                            <td style="padding: 8px 4px; text-align: center; color: #94a3b8; font-size: 13px;">${shifts.length}</td>
                            <td style="padding: 8px 4px; text-align: center; color: #10b981; font-weight: 800; font-size: 13px;">${wageResult.totalHours}</td>
                            <td style="padding: 8px 4px; text-align: center; color: #a855f7; font-weight: 800; font-size: 13px;">${wageResult.weightedTotal}</td>
                            <td style="padding: 8px 4px; text-align: right; direction: rtl;">${breakdownHtml}</td>
                        </tr>
                    `;
                } catch (calcErr) {
                    console.error(`[EmailService] Salary breakdown failed for ${employee}:`, calcErr.message);
                    let totalHours = 0;
                    shifts.forEach(s => { if (s.start && s.end) totalHours += (new Date(s.end) - new Date(s.start)) / 3600000; });
                    tableRows += `
                        <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                            <td style="padding: 8px 4px; color: #ffffff; font-size: 13px;">${employee}</td>
                            <td style="padding: 8px 4px; text-align: center; color: #94a3b8; font-size: 13px;">${shifts.length}</td>
                            <td style="padding: 8px 4px; text-align: center; color: #ffffff; font-size: 13px;">${totalHours.toFixed(2)}</td>
                            <td style="padding: 8px 4px; text-align: center; color: #ffffff; font-size: 13px;">-</td>
                            <td style="padding: 8px 4px; text-align: right; color: #f43f5e; font-size: 12px;">שגיאה</td>
                        </tr>
                    `;
                }
            }
        } catch (globalErr) {
            console.error(`[EmailService] Monthly report table generation failed:`, globalErr.message);
            tableRows = '<tr><td colspan="5" style="color:#f43f5e; text-align:center; padding: 15px;">שגיאה ביצירת הטבלה</td></tr>';
        }

        const content = `
            <div class="table-wrapper" style="background: rgba(0, 0, 0, 0.1); border-radius: 10px; overflow-x: auto; -webkit-overflow-scrolling: touch;">
                <table style="width: 100%; border-collapse: collapse; font-size: 13px; direction: rtl; min-width: 480px;">
                    <thead>
                        <tr style="background-color: rgba(255, 255, 255, 0.03); color: #94a3b8;">
                            <th style="padding: 12px 6px; text-align: right; font-weight: 700;">עובד</th>
                            <th style="padding: 12px 6px; text-align: center; font-weight: 700;">משמרות</th>
                            <th style="padding: 12px 6px; text-align: center; font-weight: 700;">סה"כ</th>
                            <th style="padding: 12px 6px; text-align: center; font-weight: 700;">שכר</th>
                            <th style="padding: 12px 6px; text-align: right; font-weight: 700;">פירוט</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows || '<tr><td colspan="5" style="padding:20px; text-align:center; color: #64748b;">אין נתונים</td></tr>'}
                    </tbody>
                </table>
            </div>
            <p style="margin-top: 20px; color: #94a3b8; font-size: 13px; text-align: center; font-style: italic;">לדוח מפורט, היכנס למערכת הניהול.</p>
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
                    locSuffix = ' <span style="font-size: 13px; opacity: 0.8;">(בטווח המותר)</span>';
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

    async sendDeltaBillingAlert(to, businessName, delta, currentCount, amount, logoUrl = null) {
        const title = 'עדכון חיוב: גידול בכמות העובדים';
        const previousCount = currentCount - delta;
        const dataManager = require('./DataManager');
        const systemConfig = dataManager.getSystemConfigSync ? dataManager.getSystemConfigSync() : {};
        const appName = systemConfig.appName || config.APP_NAME;

        const content = `
            <p style="text-align: right; color: #ffffff; font-size: 15px; margin-bottom: 20px;">שלום <strong>${businessName}</strong>,</p>
            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">המערכת זיהתה גידול בכמות העובדים הפעילים בעסק שלך במהלך מחזור החיוב הנוכחי.</p>
            
            <div style="background: rgba(99, 102, 241, 0.1); border-right: 4px solid #6366f1; padding: 20px; margin: 25px 0; border-radius: 12px;">
                <h3 style="color: #ffffff; font-size: 16px; margin: 0 0 15px 0; text-align: right;">סיכום שינויי שימוש:</h3>
                <table style="width: 100%; border-collapse: collapse;">
                    <tr>
                        <td style="padding: 8px 0; color: #94a3b8; text-align: right; font-size: 13px;">כמות עובדים קודמת:</td>
                        <td style="padding: 8px 0; color: #ffffff; text-align: left; font-weight: 700; font-size: 14px;">${previousCount}</td>
                    </tr>
                    <tr>
                        <td style="padding: 8px 0; color: #94a3b8; text-align: right; font-size: 13px;">כמות עובדים נוכחית:</td>
                        <td style="padding: 8px 0; color: #6366f1; text-align: left; font-weight: 700; font-size: 14px;">${currentCount}</td>
                    </tr>
                    <tr style="border-top: 1px solid rgba(255, 255, 255, 0.1);">
                        <td style="padding: 12px 0; color: #ffffff; text-align: right; font-size: 14px; font-weight: 700;">הפרש לחיוב (יחסי):</td>
                        <td style="padding: 12px 0; color: #10b981; text-align: left; font-weight: 900; font-size: 18px;">₪${amount}</td>
                    </tr>
                </table>
            </div>

            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 13px;">
                בהתאם למודל המנוי הגמיש של <strong>${appName}</strong>, החיוב מתעדכן אוטומטית לפי כמות העובדים הפעילים. 
                <br><br>
                <strong>שים לב:</strong> במידה וקיים אמצעי תשלום שמור, החיוב יבוצע אוטומטית. במידה ולא, אנא היכנס למערכת כדי להסדיר את ההפרש ולהבטיח פעילות רציפה.
            </p>

            <div style="text-align: center; margin-top: 30px;">
                <a href="${config.APP_URL || '#'}" style="display: inline-block; background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 12px; font-weight: 800; font-size: 16px; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);">כניסה ללוח הבקרה</a>
            </div>
        `;

        return this.sendEmail(to, `עדכון שימוש וחיוב - ${businessName}`, this.getStyledTemplate(title, content, '', logoUrl, businessName));
    }

    async sendSubscriptionAlert(to, businessName, hoursLeft, expiryDate, logoUrl = null, amount = null) {
        const daysLeft = Math.ceil(hoursLeft / 24);
        let title = `המנוי מסתיים בעוד ${daysLeft} ימים`;
        let color = '#f59e0b';

        if (hoursLeft <= 24) {
            title = `המנוי מסתיים בעוד פחות מ-24 שעות!`;
            color = '#f97316';
        } else if (hoursLeft <= 48) {
            title = `המנוי מסתיים בעוד פחות מ-48 שעות!`;
            color = '#f59e0b';
        }

        const formattedDate = new Date(expiryDate).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

        // Admin-configured intro override
        const dataManager = require('./DataManager');
        const systemConfig = dataManager.getSystemConfigSync ? dataManager.getSystemConfigSync() : {};
        const templates = systemConfig.emailTemplates || {};
        const introText = templates.expiryIntro
            ? `<p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">${templates.expiryIntro.replace(/\n/g, '<br>')}</p>`
            : `<p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">תוקף המנוי למערכת הוא עד: <strong style="color: #ffffff;">${formattedDate}</strong>.</p>`;

        const content = `
            <div style="text-align: center; margin-bottom: 20px;">
                 <div style="display: inline-block; padding: 10px 20px; background-color: ${color}15; color: ${color}; border: 1px solid ${color}30; border-radius: 50px; font-weight: 800; font-size: 16px;">
                    ${title}
                 </div>
            </div>

            <p style="text-align: right; color: #ffffff; font-size: 15px; margin-bottom: 15px;">שלום <strong>${businessName}</strong>,</p>
            ${introText}
            
            ${amount ? `
            <div style="background: rgba(255, 255, 255, 0.05); padding: 15px; border-radius: 8px; margin: 15px 0; text-align: right;">
                <p style="margin: 0; color: #94a3b8; font-size: 13px;">סכום לתשלום (כולל הפרשי שימוש):</p>
                <p style="margin: 5px 0 0 0; color: #ffffff; font-size: 20px; font-weight: 800;">₪${amount}</p>
            </div>
            ` : ''}

            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">אנא דאג לחדש את המנוי בהקדם להמשך פעילות רציפה ומניעת חסימה.</p>

            <div style="text-align: center; margin-top: 30px;">
                <a href="${config.APP_URL || '#'}" style="display: inline-block; background: linear-gradient(90deg, #6366f1 0%, #a855f7 100%); color: #ffffff; text-decoration: none; padding: 14px 35px; border-radius: 12px; font-weight: 800; font-size: 16px;">חידוש מנוי עכשיו</a>
            </div>
        `;

        return this.sendEmail(to, `התראה: ${title} - ${businessName}`, this.getStyledTemplate('סטטוס מנוי', content, '', logoUrl, businessName));
    }

    async sendGracePeriodAlert(to, businessName, expiryDate, logoUrl = null, amount = null) {
        const color = '#f43f5e';
        const formattedDate = new Date(expiryDate).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' });

        // Admin-configured intro override
        const dataManager = require('./DataManager');
        const systemConfig = dataManager.getSystemConfigSync ? dataManager.getSystemConfigSync() : {};
        const templates = systemConfig.emailTemplates || {};
        const graceHours = (parseInt(systemConfig.subscriptionExpiryNotice) || 1) * 24; // Use configured notice period
        const title = `המנוי פג — תקופת חסד פעילה`;
        const introText = templates.graceIntro
            ? `<p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">${templates.graceIntro.replace(/\n/g, '<br>')}</p>`
            : `<p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">תוקף המנוי שלך פג בתאריך: <strong style="color: #ffffff;">${formattedDate}</strong>.</p>`;

        const content = `
            <div style="text-align: center; margin-bottom: 20px;">
                 <div style="display: inline-block; padding: 10px 20px; background-color: ${color}15; color: ${color}; border: 1px solid ${color}30; border-radius: 50px; font-weight: 800; font-size: 16px;">
                    ${title}
                 </div>
            </div>

            <p style="text-align: right; color: #ffffff; font-size: 15px; margin-bottom: 15px;">שלום <strong>${businessName}</strong>,</p>
            ${introText}
            
            <div style="background: rgba(244, 63, 94, 0.1); border-right: 4px solid #f43f5e; padding: 20px; margin: 20px 0; border-radius: 12px;">
                <p style="margin: 0; color: #ffffff; font-weight: 700; text-align: right;">לרשותך תקופת חסד לפני חסימה מלאה של המערכת.</p>
                <p style="margin: 10px 0 0 0; color: #94a3b8; font-size: 13px; text-align: right;">שימוש במערכת במהלך תקופת החסד ייספר כפעילות במחזור החיוב הנוכחי.</p>
            </div>

            <p style="text-align: right; color: #94a3b8; line-height: 1.6; font-size: 14px;">אנא הסדר את התשלום כעת כדי למנוע השבתה של האפליקציה עבורך ועבור עובדיך.</p>

            <div style="text-align: center; margin-top: 30px;">
                <a href="${config.APP_URL || '#'}" style="display: inline-block; background: #f43f5e; color: #ffffff; text-decoration: none; padding: 14px 40px; border-radius: 12px; font-weight: 800; font-size: 16px; box-shadow: 0 4px 15px rgba(244, 63, 94, 0.3);">לתשלום וחידוש המנוי</a>
            </div>
        `;

        return this.sendEmail(to, `חשוב: המנוי פג — נדרש חידוש - ${businessName}`, this.getStyledTemplate('התראת תפוגה', content, '', logoUrl, businessName));
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
