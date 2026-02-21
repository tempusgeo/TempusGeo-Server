const express = require('express');
const router = express.Router();
const authService = require('../services/AuthService');
const dataManager = require('../services/DataManager');
const tranzilaService = require('../services/TranzilaService');
const emailService = require('../services/EmailService');

// ================================================================
// UNIVERSAL ACTION DISPATCHER
// Maps old GAS-style action-based POST bodies to Render REST logic
// ================================================================
router.post('/dispatch', async (req, res) => {
    const { action, companyId, password, ...rest } = req.body || {};
    console.log(`[Dispatch] action=${action} companyId=${companyId}`);

    try {
        switch (action) {
            // === BUSINESS SETUP ===
            case 'createNewBusiness': {
                const client = await dataManager.createBusiness(req.body);
                // Also load the full config for the new business
                const config = await dataManager.getCompanyConfig(client.id).catch(() => ({}));
                return res.json({ success: true, companyId: client.id, config });
            }

            // === AUTH ===
            case 'getBusinessConfig': {
                if (!companyId) return res.json({ success: false, error: 'Missing companyId' });
                const config = await dataManager.getCompanyConfig(companyId);
                if (!config) return res.json({ success: false, error: 'Company not found' });
                return res.json({ success: true, config });
            }

            case 'adminLogin': {
                const result = await authService.adminLogin(companyId, password);
                if (result.success) {
                    // Also include daysRemaining for admin panel subscription banner
                    const expiry = new Date(result.expiryDate);
                    const daysRemaining = Math.ceil((expiry - new Date()) / (1000 * 60 * 60 * 24));
                    result.daysRemaining = daysRemaining;

                    // Enrich response with additional data the admin panel expects
                    try {
                        const fullConfig = result.config || {};
                        result.adminEmail = fullConfig.adminEmail || '';
                        result.logoUrl = fullConfig.logoUrl || '';
                        result.allEmployees = fullConfig.employees || [];
                        result.availableHolidays = [];
                        result.dashboard = await dataManager.getDashboard(result.companyId).catch(() => []);
                    } catch (enrichErr) {
                        console.error('[adminLogin] Enrich error:', enrichErr.message);
                    }
                }
                return res.json(result);
            }

            case 'forgotAdminPassword': {
                // Pass emailService explicitly - AuthService no longer imports it (avoids circular require)
                const result = await authService.forgotAdminPassword(companyId, emailService);
                return res.json(result);
            }

            case 'changeAdminPassword': {
                const result = await authService.changeAdminPassword(companyId, password, rest.newPassword);
                return res.json(result);
            }

            case 'recoverSubscription': {
                // Attempt to reload config after payment webhook
                const config = await dataManager.getCompanyConfig(companyId);
                return res.json({ success: !!config, config });
            }

            case 'getPublicPaymentConfig': {
                // Return the system payment config (for employees to initiate subscription renewal)
                const sysConfig = await dataManager.getSystemConfig();
                const active = !!(sysConfig.tranzilaTerminal && sysConfig.tranzilaPlans && sysConfig.tranzilaPlans.length > 0);
                return res.json({
                    success: true,
                    active,
                    adminWhatsapp: sysConfig.adminWhatsapp || '',
                    plans: sysConfig.tranzilaPlans || []
                });
            }

            // === EMPLOYEE CHECKIN/OUT ===
            case 'checkIn':
            case 'checkOut': {
                const type = action === 'checkIn' ? 'IN' : 'OUT';
                const result = await dataManager.logShift(companyId, rest.name, type, Date.now());
                const status = await dataManager.getEmployeeStatus(companyId, rest.name);
                return res.json({ success: true, ...status, message: type === 'IN' ? 'נכנסת בהצלחה' : 'יצאת בהצלחה' });
            }

            case 'getStatus': {
                const status = await dataManager.getEmployeeStatus(companyId, rest.name);
                return res.json({ success: true, ...status });
            }

            // === REPORTS ===
            case 'getYears': {
                const shifts = await dataManager.getShiftYears(companyId);
                return res.json({ success: true, years: shifts });
            }

            case 'getMonths': {
                const months = await dataManager.getShiftMonths(companyId, rest.year);
                return res.json({ success: true, months });
            }

            case 'getReport': {
                const data = await dataManager.getShiftsHybrid(companyId, parseInt(rest.year), parseInt(rest.month));
                const userShifts = rest.name ? (data[rest.name] || []) : data;
                return res.json({ success: true, shifts: userShifts });
            }

            case 'getEmployeesForMonth': {
                const data = await dataManager.getShiftsHybrid(companyId, parseInt(rest.year), parseInt(rest.month));
                return res.json({ success: true, data });
            }

            // === ADMIN OPERATIONS ===
            case 'getDashboard': {
                const dashboard = await dataManager.getDashboard(companyId);
                return res.json({ success: true, dashboard });
            }

            case 'adminForceAction': {
                const fRes = await dataManager.adminForceCheckout(companyId, rest.name, rest.forceType);
                return res.json(fRes);
            }

            case 'adminSaveShift': {
                const sRes = await dataManager.adminSaveShift(companyId, rest.name, rest.year, rest.month, rest.rowIndex, rest.date, rest.start, rest.end);
                return res.json(sRes || { success: true });
            }

            case 'adminDeleteShift': {
                const dRes = await dataManager.adminDeleteShift(companyId, rest.name, rest.year, rest.month, rest.rowIndex);
                return res.json(dRes || { success: true });
            }

            case 'adminSendMonthlyReport': {
                const config = await dataManager.getCompanyConfig(companyId);
                const reportData = await dataManager.getShiftsHybrid(companyId, parseInt(rest.year), parseInt(rest.month));
                await emailService.sendMonthlyReport(config.adminEmail, reportData, parseInt(rest.year), parseInt(rest.month), config.businessName);
                return res.json({ success: true });
            }

            case 'adminExportFullHistory': {
                // Redirect to GAS cold storage for full export
                return res.json({ success: false, error: 'Use GAS export endpoint directly', redirectToGAS: true });
            }

            case 'getUserFullHistory': {
                const allData = await dataManager.getUserFullHistory(companyId, rest.name);
                return res.json({ success: true, shifts: allData });
            }

            // === SETTINGS ===
            case 'getAdminSettings': {
                const config = await dataManager.getCompanyConfig(companyId);
                return res.json({ success: true, settings: config?.settings || {}, adminEmail: config?.adminEmail || '' });
            }

            case 'saveAdminSettings': {
                await dataManager.updateCompanySettings(companyId, rest.settings, rest.adminEmail);
                return res.json({ success: true });
            }

            case 'adminSavePolygon': {
                await dataManager.updateCompanyPolygon(companyId, rest.polygon);
                return res.json({ success: true });
            }

            case 'updateBusinessConfig': {
                await dataManager.updateCompanyConfig(companyId, rest);
                return res.json({ success: true });
            }

            // === DANGER ZONE ===
            case 'adminDeleteBusiness': {
                // Validate using super-admin (god mode) password, not company password
                if (!password || !isValidSuperAdminPassword(password)) {
                    return res.json({ success: false, error: 'Unauthorized: Invalid super admin password' });
                }

                await dataManager.deleteBusiness(companyId);
                return res.json({ success: true, message: 'Business deleted successfully' });
            }

            // === PAYMENT ===
            case 'initTranzilaPayment': {
                // This is handled by the dedicated /payment/process route
                return res.json({ success: false, error: 'Use /payment/process directly' });
            }

            case 'processTranzilaTransaction': {
                // Forward to internal payment processor
                req.body.paymentDetails = rest.paymentDetails || rest.cardData;
                req.body.price = rest.price;
                // Re-dispatch to the payment route handler inline
                req.url = '/payment/process';
                return router.handle(req, res);
            }

            default:
                return res.json({ success: false, error: `Unknown action: ${action}` });
        }
    } catch (e) {
        console.error(`[Dispatch] Error in action ${action}:`, e.message);
        return res.status(500).json({ success: false, error: e.message });
    }
});

// --- AUTHENTICATION ---

router.post('/login', async (req, res) => {
    try {
        const { email, companyId, password } = req.body;
        const result = await authService.adminLogin(companyId || email, password);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/forgot-password', async (req, res) => {
    try {
        const { companyId } = req.body;
        if (!companyId) return res.status(400).json({ success: false, error: "Missing companyId" });

        const result = await authService.forgotAdminPassword(companyId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/change-password', async (req, res) => {
    try {
        const { companyId, oldPassword, newPassword } = req.body;
        if (!companyId || !oldPassword || !newPassword) return res.status(400).json({ success: false, error: "Missing params" });

        const result = await authService.changeAdminPassword(companyId, oldPassword, newPassword);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- SUPER ADMIN ---

// Helper: Validate password against comma-separated list
function isValidSuperAdminPassword(inputPassword) {
    const envPass = process.env.SUPER_ADMIN_PASS || '123456';
    const validPasswords = envPass.split(',').map(p => p.trim());
    return validPasswords.includes(inputPassword);
}

router.post('/super-admin/login', async (req, res) => {
    try {
        const { password } = req.body;
        if (isValidSuperAdminPassword(password)) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: "Invalid Password" });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/super-admin/businesses', async (req, res) => {
    console.log('[SUPER-ADMIN] /businesses endpoint hit');
    try {
        const { password } = req.body;
        console.log('[SUPER-ADMIN] Password check...');
        if (!isValidSuperAdminPassword(password)) {
            console.log('[SUPER-ADMIN] Unauthorized');
            return res.status(401).json({ success: false, error: "Unauthorized" });
        }

        console.log('[SUPER-ADMIN] Fetching businesses...');
        const businesses = await dataManager.getAllClientsWithStatus();
        console.log(`[SUPER-ADMIN] Found ${businesses.length} businesses`);
        res.json({ success: true, businesses });
    } catch (e) {
        console.error('[SUPER-ADMIN] Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/super-admin/settings/get', async (req, res) => {
    try {
        const { password } = req.body;
        if (!isValidSuperAdminPassword(password)) return res.status(401).json({ success: false, error: "Unauthorized" });

        const config = await dataManager.getSystemConfig();
        res.json({
            success: true,
            settings: {
                adminWhatsapp: config.adminWhatsapp || '',
                tranzilaTerminal: config.tranzilaTerminal || '',
                tranzilaPass: config.tranzilaPass || '',
                tranzilaPlans: config.tranzilaPlans || []
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/super-admin/settings/update', async (req, res) => {
    try {
        const { password, phone, tranzilaTerminal, tranzilaPass, tranzilaPlans } = req.body;
        if (!isValidSuperAdminPassword(password)) return res.status(401).json({ success: false, error: "Unauthorized" });

        await dataManager.updateSystemConfig({
            adminWhatsapp: phone,
            tranzilaTerminal,
            tranzilaPass,
            tranzilaPlans
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/super-admin/storage', async (req, res) => {
    try {
        const { password } = req.body;
        if (!isValidSuperAdminPassword(password)) return res.status(401).json({ success: false, error: "Unauthorized" });

        const stats = await dataManager.getStorageStats();
        res.json({ success: true, stats });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/super-admin/record-payment', async (req, res) => {
    try {
        const { password, targetCompanyId, amount, months, method, reference } = req.body;
        if (!isValidSuperAdminPassword(password)) return res.status(401).json({ success: false, error: "Unauthorized" });
        if (!targetCompanyId) return res.status(400).json({ success: false, error: "Missing targetCompanyId" });

        const client = await dataManager.getClientById(targetCompanyId);
        if (!client) return res.status(404).json({ success: false, error: "Business not found" });

        // Adjust subscription expiry
        const currentExpiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : new Date();
        const now = new Date();
        // If already expired, start from now
        const baseDate = currentExpiry < now ? now : currentExpiry;

        // Add months (handle negative months for refund/shortening)
        const newExpiry = new Date(baseDate);
        newExpiry.setMonth(newExpiry.getMonth() + parseInt(months));
        client.subscriptionExpiry = newExpiry.toISOString();

        // Record in payment history
        if (!client.paymentHistory) client.paymentHistory = [];
        client.paymentHistory.push({
            date: new Date().toLocaleDateString('he-IL'),
            amount: Math.abs(amount),
            currency: 'ILS',
            period: Math.abs(months),
            method: method || 'Manual',
            reference: reference || '',
            status: amount < 0 ? 'REFUND' : 'PAID',
            isGodAction: true
        });

        await dataManager.saveClients();

        res.json({
            success: true,
            newExpiry: newExpiry.toLocaleDateString('he-IL'),
            message: months < 0 ? 'המנוי קוצר בהצלחה' : 'המנוי חודש בהצלחה'
        });
    } catch (e) {
        console.error('[SuperAdmin] record-payment error:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- PUBLIC CONFIG (Employee App) ---

router.get('/config', async (req, res) => {
    try {
        const { companyId } = req.query;
        if (!companyId) return res.status(400).json({ success: false, error: "Missing companyId" });

        const config = await dataManager.getCompanyConfig(companyId);
        res.json({ success: true, config });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- STATUS & DASHBOARD ---

router.get('/status', async (req, res) => {
    try {
        const { companyId, userName } = req.query;
        if (!companyId || !userName) return res.status(400).json({ success: false, error: "Missing params" });

        const status = await dataManager.getEmployeeStatus(companyId, userName);
        res.json({ success: true, ...status });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/dashboard', async (req, res) => {
    try {
        const { companyId } = req.query;
        if (!companyId) return res.status(400).json({ success: false, error: "Missing companyId" });
        const dashboard = await dataManager.getDashboard(companyId);
        res.json({ success: true, dashboard });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/employees', async (req, res) => {
    try {
        const { companyId } = req.query;
        if (!companyId) return res.status(400).json({ success: false, error: "Missing companyId" });

        const employees = await dataManager.getEmployees(companyId);
        res.json({ success: true, employees });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/shift', async (req, res) => {
    try {
        const { companyId, userName, action, timestamp, location, note } = req.body;
        if (!companyId || !userName || !action) return res.status(400).json({ success: false, error: "Missing params" });

        const result = await dataManager.logShift(companyId, userName, action, timestamp || Date.now());

        // Return updated status immediately
        const newStatus = await dataManager.getEmployeeStatus(companyId, userName);

        res.json({ success: true, ...newStatus, message: action === "IN" ? "נכנסת בהצלחה" : "יצאת בהצלחה" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- HISTORY (HYBRID: Hot + Cold) ---

router.get('/history', async (req, res) => {
    try {
        const { companyId, userName, year, month } = req.query;

        // Use hybrid method (hot disk or cold GAS)
        const shifts = await dataManager.getShiftsHybrid(companyId, parseInt(year), parseInt(month));

        // Filter for specific user if provided
        let userShifts = [];
        if (userName) {
            userShifts = shifts[userName] || [];
        } else {
            // Admin request for all? Return raw object?
            // Client expects 'shifts' array usually. But admin table loads per user.
            // If no user, maybe we return nothing or full object?
            // Let's stick to per-user for now as per client logic.
        }

        res.json({ success: true, shifts: userShifts, source: dataManager.isHotMonth(parseInt(year), parseInt(month)) ? 'hot' : 'cold' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/history/years', async (req, res) => {
    try {
        const { companyId } = req.query;
        const years = await dataManager.getHistoryYears(companyId);
        res.json({ success: true, years });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/history/months', async (req, res) => {
    try {
        const { companyId, year } = req.query;
        const months = await dataManager.getHistoryMonths(companyId, year);
        res.json({ success: true, months });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/history/employees', async (req, res) => {
    try {
        const { companyId, year, month } = req.query;
        const shifts = await dataManager.getShiftsHybrid(companyId, parseInt(year), parseInt(month));
        const employees = Object.keys(shifts).sort();
        res.json({ success: true, employees });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// POST versions for CLIENT_USER compatibility (uses JSON body instead of query params)
router.post('/history/years', async (req, res) => {
    try {
        const { companyId } = req.body;
        const years = await dataManager.getHistoryYears(companyId);
        res.json({ success: true, years });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/history/months', async (req, res) => {
    try {
        const { companyId, year } = req.body;
        const months = await dataManager.getHistoryMonths(companyId, year);
        res.json({ success: true, months });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/history/report', async (req, res) => {
    try {
        const { companyId, year, month, name } = req.body;
        const shifts = await dataManager.getShiftsHybrid(companyId, parseInt(year), parseInt(month));
        const userShifts = shifts[name] || [];

        // Calculate total hours
        let totalHours = 0;
        userShifts.forEach(shift => {
            if (shift.duration) {
                totalHours += parseFloat(shift.duration);
            }
        });

        res.json({
            success: true,
            shifts: userShifts,
            totalHours: totalHours.toFixed(2),
            source: dataManager.isHotMonth(parseInt(year), parseInt(month)) ? 'hot' : 'cold'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// --- BACKUP (For GAS) ---

router.get('/backup', async (req, res) => {
    try {
        const backupData = await dataManager.getBackupData();
        res.json({ success: true, data: backupData });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- TRANZILA / PAYMENT ---

router.post('/payment/webhook', async (req, res) => {
    try {
        // Webhook from JetServer after payment
        const { success, companyId, packageName, price, transactionId, confirmationCode } = req.body;

        if (!success || !companyId) {
            return res.status(400).json({ success: false, error: 'Invalid webhook data' });
        }

        // Update subscription in database
        const client = await dataManager.getClientById(companyId);
        if (!client) {
            return res.status(404).json({ success: false, error: 'Company not found' });
        }

        // Calculate newExpiry date (e.g. 30 days or based on package)
        const newExpiry = new Date();
        // Simple logic: add 30 days. Real logic might parse packageName.
        newExpiry.setDate(newExpiry.getDate() + 30);

        // Update client data
        client.subscriptionExpiry = newExpiry.toISOString();
        client.lastPayment = {
            date: new Date().toISOString(),
            amount: price,
            package: packageName,
            transactionId,
            confirmationCode
        };

        await dataManager.saveClients();

        console.log(`[Payment] Subscription updated for ${companyId}: ${packageName} (₪${price})`);

        res.json({ success: true, message: 'Subscription updated' });
    } catch (e) {
        console.error('[Payment Webhook] Error:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/payment/verify', async (req, res) => {
    try {
        // Frontend sends us the iframe payload
        const result = await tranzilaService.verifyTransaction(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- SUPER ADMIN LOGIN ---
router.post('/super-admin/login', async (req, res) => {
    try {
        const { password } = req.body;

        // AUTHENTICATION STRATEGY: PASSWORD ONLY LIST
        // Configured in Render Dashboard as comma-separated values
        // e.g. "pass1,pass2,secret123"
        const envPass = process.env.SUPER_ADMIN_PASS || '123456';
        const allowedPasswords = envPass.split(',').map(p => p.trim());

        // Validate
        if (allowedPasswords.includes(password)) {
            // Success!
            res.json({ success: true });
        } else {
            res.json({ success: false, error: "Invalid credentials" });
        }

    } catch (error) {
        console.error("Super Admin Login Error:", error);
        res.status(500).json({ success: false, error: "Auth failed: " + error.message });
    }
});

// --- ADMIN AUTH ---

router.post('/admin/data', async (req, res) => {
    try {
        const { companyId, password } = req.body;

        const client = await dataManager.getClientById(companyId);
        if (!client) return res.status(404).json({ success: false, error: 'Company not found' });

        if (client.password !== password) {
            return res.status(401).json({ success: false, error: 'Incorrect password' });
        }

        const config = await dataManager.getCompanyConfig(companyId);

        res.json({
            success: true,
            settings: config.settings || {},
            adminEmail: config.adminEmail,
            logoUrl: config.logoUrl,
            allEmployees: await dataManager.getEmployees(companyId),
            paymentHistory: client.lastPayment ? [client.lastPayment] : [],
            expiryDate: client.subscriptionExpiry ? new Date(client.subscriptionExpiry).toLocaleDateString('he-IL') : 'Unknown',
            isExpired: client.subscriptionExpiry ? new Date(client.subscriptionExpiry) < new Date() : false
        });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- USER EXPORT TO EMAIL (NON-BLOCKING) ---
router.post('/user/export-email', async (req, res) => {
    try {
        const { companyId, userName, email } = req.body;

        if (!email || !userName) {
            return res.status(400).json({ success: false, error: "Missing email or user" });
        }

        // 1. Respond Immediately (Non-Blocking)
        res.json({ success: true, message: "Request received. Email will be sent shortly." });

        // 2. Background Process
        (async () => {
            try {
                // Fetch Hot Data (Current + Last Month) to ensure GAS has latest
                const now = new Date();
                const currentYear = now.getFullYear();
                const currentMonth = now.getMonth() + 1;

                let lastMonth = currentMonth - 1;
                let lastMonthYear = currentYear;
                if (lastMonth === 0) {
                    lastMonth = 12;
                    lastMonthYear = currentYear - 1;
                }

                const hotData = {};
                // Current Month
                const currentData = await dataManager.getShifts(companyId, currentYear, currentMonth);
                if (currentData[userName]) hotData[`${currentYear}-${currentMonth}`] = currentData[userName];

                // Last Month
                const lastData = await dataManager.getShifts(companyId, lastMonthYear, lastMonth);
                if (lastData[userName]) hotData[`${lastMonthYear}-${lastMonth}`] = lastData[userName];

                // 3. Trigger GAS
                const gasUrl = config.GAS_COLD_STORAGE_URL;
                if (gasUrl) {
                    // Fire and forget (or log result)
                    await fetch(gasUrl, {
                        method: 'POST',
                        body: JSON.stringify({
                            action: 'exportUserHistory',
                            companyId,
                            userId: userName, // User Name is ID in this system
                            email,
                            hotData
                        })
                    });
                    console.log(`[Export-Email] Triggered GAS for ${userName} -> ${email}`);
                } else {
                    console.error("[Export-Email] GAS URL not configured");
                }

            } catch (bgError) {
                console.error(`[Export-Email] Background Error: ${bgError.message}`);
            }
        })();

    } catch (e) {
        console.error(`[Export-Email] Error: ${e.message}`);
        // Only valid if we haven't responded yet, but likely we have.
        if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
    }
});

// 1. Settings (Salary, Constraints, Email)
router.post('/admin/settings', async (req, res) => {
    try {
        const { companyId, settings, adminEmail } = req.body;
        await dataManager.saveAdminSettings(companyId, settings, adminEmail);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Business Config (Name, Logo)
router.post('/admin/business', async (req, res) => {
    try {
        const { companyId, businessName, logoUrl, logoBase64 } = req.body;
        const update = { businessName };
        if (logoUrl) update.logoUrl = logoUrl;
        if (logoBase64) update.logoUrl = logoBase64;

        await dataManager.updateCompanyConfig(companyId, update);
        res.json({ success: true, config: await dataManager.getCompanyConfig(companyId) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Polygon (Geofence)
router.post('/admin/polygon', async (req, res) => {
    try {
        const { companyId, polygon } = req.body;
        await dataManager.savePolygon(companyId, polygon);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. Password Management
router.post('/admin/password', async (req, res) => {
    try {
        const { companyId, password, newPassword } = req.body;
        const result = await authService.changeAdminPassword(companyId, password, newPassword);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/admin/forgot-password', async (req, res) => {
    try {
        const { companyId } = req.body;
        const result = await authService.forgotAdminPassword(companyId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 5. Employee Management
router.post('/admin/employee', async (req, res) => {
    try {
        const { companyId, name, action } = req.body;
        if (action === 'delete') {
            await dataManager.deleteEmployee(companyId, name);
        } else {
            await dataManager.addEmployee(companyId, name);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 6. Shift Management (Admin Edit/Delete/Force)
router.post('/admin/shift/update', async (req, res) => {
    try {
        const { companyId, ...data } = req.body;
        await dataManager.adminSaveShift(companyId, data);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/admin/shift/delete', async (req, res) => {
    try {
        const { companyId, ...data } = req.body;
        await dataManager.adminDeleteShift(companyId, data);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/admin/shift/force', async (req, res) => {
    try {
        const { companyId, ...data } = req.body;
        // forceType: 'checkIn' | 'checkOut'
        await dataManager.adminForceAction(companyId, data);
        // Returns updated dashboard
        const dashboard = await dataManager.getDashboard(companyId);
        res.json({ success: true, dashboard, message: 'הפעולה בוצעה בהצלחה' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 7. Reports (Email)
router.post('/admin/report/send', async (req, res) => {
    try {
        const { companyId, year, month } = req.body;
        const client = await dataManager.getClientById(companyId);
        if (!client || !client.email) throw new Error("No admin email found");

        // Generate Report Data (Hot/Cold)
        const reportData = await dataManager.getShiftsHybrid(companyId, parseInt(year), parseInt(month));

        // In GAS this was sending CSV. Here we just call emailService.
        // EmailService needs to format it.
        await emailService.sendMonthlyReport(client.email, reportData, year, month, client.businessName);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// --- EXPORT ---

router.post('/admin/export', async (req, res) => {
    try {
        const { companyId } = req.body;
        const files = await dataManager.getFullHistoryForExport(companyId);

        if (files.length === 0) return res.status(404).json({ success: false, error: "No data found" });

        const archiver = require('archiver');
        const archive = archiver('zip', { zlib: { level: 9 } });

        res.attachment(`TempusGeo_History_${companyId}.zip`);
        archive.pipe(res);

        for (const file of files) {
            archive.file(file.path, { name: `${file.name}.json` });
        }

        await archive.finalize();
    } catch (e) {
        console.error("Export Error:", e);
        if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/user/export', async (req, res) => {
    try {
        const { companyId, userName } = req.body;
        const name = userName; // Map for internal logic
        const now = new Date();
        const year = now.getFullYear();

        const shifts = [];
        // Iterate all months for current year?
        // Or just return last month? User usually wants recent history.
        // Let's grab all 12 months for current year.
        for (let m = 1; m <= 12; m++) {
            try {
                const data = await dataManager.getShifts(companyId, year, m);
                const userShifts = data[name] || [];
                userShifts.forEach(s => {
                    // Format for client
                    const dStr = s.start || s.end;
                    if (!dStr) return;
                    const dObj = new Date(dStr);

                    shifts.push({
                        date: dObj.toLocaleDateString('he-IL'),
                        day: dObj.toLocaleDateString('he-IL', { weekday: 'long' }),
                        month: m,
                        year: year,
                        start: s.start ? new Date(s.start).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '-',
                        end: s.end ? new Date(s.end).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '-',
                        duration: s.end && s.start ? ((new Date(s.end) - new Date(s.start)) / 3600000).toFixed(2) : '0'
                    });
                });
            } catch (e) { }
        }

        res.json({ success: true, shifts });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- PAYMENT PROXY ---
router.post('/payment/process', async (req, res) => {
    try {
        const result = await tranzilaService.processPaymentProxy(req.body);
        res.json(result);
    } catch (e) {
        console.error("Payment Process Error", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/payment/config', (req, res) => {
    res.json({
        success: true,
        active: true,
        plans: [
            { id: '1', title: 'מנוי חודשי', price: 29, currency: 'ILS', months: 1 },
            { id: '2', title: 'מנוי שנתי', price: 290, currency: 'ILS', months: 12 }
        ]
    });
});

router.post('/register', async (req, res) => {
    try {
        const client = await dataManager.createBusiness(req.body);
        res.json({ success: true, companyId: client.id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- DYNAMIC PAYMENT CONFIG (For JetServer) ---

// 1. Get Config (Protected - for JetServer PHP only)
router.get('/internal/payment-config', async (req, res) => {
    try {
        const token = req.headers['x-jetserver-token'];
        // In a real scenario, this token should be configurable/in env vars.
        // For simplicity/requirement, we'll check against a known fallback or config.
        // Let's assume the user sets JETSERVER_TOKEN in Render Env Vars.
        const validToken = process.env.JETSERVER_TOKEN || 'default-secure-token';

        if (token !== validToken) {
            return res.status(401).json({ success: false, error: "Unauthorized JetServer Token" });
        }

        const config = await dataManager.getSystemConfig();
        res.json({
            success: true,
            terminalName: config.tranzilaTerminal || '',
            terminalPass: config.tranzilaPass || ''
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. Set Config (Admin Only)
router.post('/admin/payment-config', async (req, res) => {
    try {
        const { companyId, terminalName, terminalPass } = req.body;
        // Verify admin permissions (simple check via companyId/password logic usually handled by client, 
        // but here we trust the caller has passed the 'login' check or strictly:
        // Ideally we need a session/token. For this scope:

        await dataManager.updateSystemConfig({
            tranzilaTerminal: terminalName,
            tranzilaPass: terminalPass
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Get Config (Admin Only - for UI)
router.post('/admin/get-payment-config', async (req, res) => {
    try {
        const { password } = req.body;

        // Validate Super Admin (Password Only List)
        const envPass = process.env.SUPER_ADMIN_PASS || '123456';
        const allowedPasswords = envPass.split(',').map(p => p.trim());

        if (!allowedPasswords.includes(password)) {
            return res.status(401).json({ success: false, error: "Unauthorized" });
        }

        const config = await dataManager.getSystemConfig();
        // Return sensitive data because it's the admin asking
        res.json({
            success: true,
            terminalName: config.tranzilaTerminal || '',
            terminalPass: config.tranzilaPass || ''
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// 4. Process Payment via Proxy
router.post('/payment/process', async (req, res) => {
    try {
        const { companyId, planId, paymentDetails, price } = req.body;
        // Support old cardData format if legacy client, but prefer paymentDetails
        const cardInfo = paymentDetails || req.body.cardData;

        // 1. Get System Config (Tranzila Credentials)
        const config = await dataManager.getSystemConfig();
        if (!config.tranzilaTerminal || !config.tranzilaPass) {
            console.error("Payment Config Missing locally");
            return res.status(500).json({ success: false, error: "Payment Gateway not configured (Contact Admin)" });
        }

        // 2. Prepare Payload for JetServer Proxy
        const proxyPayload = {
            // Credentials
            terminalName: config.tranzilaTerminal,
            terminalPass: config.tranzilaPass,

            // Transaction Data
            sum: price || '0',
            ccno: cardInfo.cardNumber,
            expmonth: cardInfo.expMonth || cardInfo.expiry.split('/')[0], // Handle both formats
            expyear: cardInfo.expYear || cardInfo.expiry.split('/')[1],
            mycvv: cardInfo.cvv,
            myid: cardInfo.cardId || cardInfo.idNumber, // Handle both key names
            contact: cardInfo.cardName || cardInfo.cardHolder,
            companyId: companyId,
            pdesc: `Plan: ${planId}`
        };

        // 3. Send to JetServer Proxy
        // Default to external URL if not in config
        const jetServerUrl = process.env.JETSERVER_PROXY_URL ||
            config.jetServerUrl;

        if (!jetServerUrl || jetServerUrl.includes('YOUR_JETSERVER_DOMAIN')) {
            return res.status(500).json({
                success: false,
                error: "CONFIGURATION ERROR: Please set 'JETSERVER_PROXY_URL' in Render Environment Variables to your PHP file address."
            });
        }

        // We use fetch (Node 18+)
        const proxyRes = await fetch(jetServerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-jetserver-token': process.env.JETSERVER_TOKEN || 'SysToken_2026_TranzilaLink'
            },
            body: JSON.stringify(proxyPayload)
        });

        if (!proxyRes.ok) {
            const errText = await proxyRes.text();
            console.error("Proxy Error:", errText);
            throw new Error(`Proxy Failed: ${proxyRes.status}`);
        }

        const proxyData = await proxyRes.json();

        // 4. Handle Success
        if (proxyData.success) {
            // Parse Tranzila Raw
            // Tranzila returns format: Response=000&id=123...
            // We use URLSearchParams to parse it
            const params = new URLSearchParams(proxyData.tranzila_raw);
            const responseCode = params.get('Response');

            if (responseCode === '000') {
                // Success!
                await dataManager.extendSubscription(companyId, planId, price);
                res.json({ success: true });
            } else {
                res.json({ success: false, error: "Declined: " + (params.get('text') || 'Unknown') });
            }
        } else {
            res.status(500).json({ success: false, error: proxyData.error });
        }

    } catch (e) {
        console.error("Payment Process Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// --- MAINTENANCE (GAS TRIGGERS) ---

// Middleware for Maintenance Auth
const maintenanceAuth = (req, res, next) => {
    const token = req.headers['x-maintenance-token'];
    const validToken = process.env.MAINTENANCE_TOKEN || process.env.JETSERVER_TOKEN || 'maintenance-secret-123';
    if (token !== validToken) {
        return res.status(401).json({ success: false, error: "Unauthorized Maintenance Token" });
    }
    next();
};

router.post('/maintenance/auto-checkout', maintenanceAuth, async (req, res) => {
    try {
        const results = await dataManager.performAutoCheckout();
        console.log(`[Maintenance] Auto-Checkout: Checked ${results.checked}, Closed ${results.closed}, Errors: ${results.errors.length}`);
        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/maintenance/subscription-check', maintenanceAuth, async (req, res) => {
    try {
        const results = await dataManager.checkSubscriptions();
        console.log(`[Maintenance] SubCheck: Expired ${results.expired}, Valid ${results.valid}`);
        res.json({ success: true, results });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/maintenance/monthly-reports', maintenanceAuth, async (req, res) => {
    try {
        // Defaults to previous month
        const now = new Date();
        let year = now.getFullYear();
        let month = now.getMonth(); // 0-11. If 0 (Jan), we want Dec of prev year.

        if (month === 0) {
            month = 12;
            year -= 1;
        }

        // Allow override
        if (req.body.year && req.body.month) {
            year = parseInt(req.body.year);
            month = parseInt(req.body.month);
        }

        console.log(`[Maintenance] Starting Monthly Reports for ${month}/${year}`);

        let sent = 0;
        let errors = 0;

        const clients = dataManager.CACHE.clients;
        for (const client of clients) {
            if (!client.email) continue;
            try {
                const reportData = await dataManager.getShiftsHybrid(client.id, year, month);
                await emailService.sendMonthlyReport(client.email, reportData, year, month, client.businessName);
                sent++;
            } catch (e) {
                console.error(`Failed report for ${client.id}: ${e.message}`);
                errors++;
            }
        }

        console.log(`[Maintenance] Reports Sent: ${sent}, Errors: ${errors}`);
        res.json({ success: true, sent, errors });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

module.exports = router;
