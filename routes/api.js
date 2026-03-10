const express = require('express');
const router = express.Router();
const authService = require('../services/AuthService');
const dataManager = require('../services/DataManager');
const tranzilaService = require('../services/TranzilaService');
const emailService = require('../services/EmailService');
const WageCalculator = require('../services/WageCalculator');
const config = require('../config');
const axios = require('axios');

// ================================================================
// UNIVERSAL ACTION DISPATCHER
// Maps old GAS-style action-based POST bodies to Render REST logic
// ================================================================
router.post('/dispatch', async (req, res) => {
    const { action, companyId, password, ...rest } = req.body || {};
    console.log(`[Dispatch] action=${action} companyId=${companyId}`);

    try {
        // --- HELPER FOR SUMMARIES ---
        const formatHHMM = (decimalHours) => {
            const h = Math.floor(decimalHours);
            const m = Math.round((decimalHours - h) * 60);
            return `${h}:${m.toString().padStart(2, '0')}`;
        };

        const getMonthlySummary = async (cid, name) => {
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1;
            const bizConfig = await dataManager.getCompanyConfig(cid);
            if (!bizConfig) return null;

            const shifts = await dataManager.getShifts(cid, year, month);
            let empShifts = shifts[name] || [];

            // LIVE INJECTION: If last shift is active, inject current time as 'end' 
            // so WageCalculator includes it in the live summary
            if (empShifts.length > 0) {
                const last = empShifts[empShifts.length - 1];
                if (last && last.start && !last.end) {
                    // Clone to avoid modifying the original shifts object in CACHE
                    empShifts = JSON.parse(JSON.stringify(empShifts));
                    empShifts[empShifts.length - 1].end = Date.now();
                }
            }

            const holidayDates = await dataManager.getHolidayDatesForMonth(cid, year, month);
            const wageResult = WageCalculator.calculateBreakdown(empShifts, bizConfig.settings?.salary || {}, holidayDates);
            return {
                totalHours: formatHHMM(wageResult.totalHours),
                weightedHours: formatHHMM(wageResult.weightedTotal),
                totalHoursRaw: wageResult.totalHours, // Raw decimal for live frontend updates
                weightedHoursRaw: wageResult.weightedTotal, // Raw decimal for live frontend updates
                wageBreakdown: wageResult.breakdown
            };
        };

        const calculateDuration = (start, end) => {
            if (!start || !end) return "00:00";
            const diffMs = parseInt(end) - parseInt(start);
            const h = Math.floor(diffMs / 3600000);
            const m = Math.floor((diffMs % 3600000) / 60000);
            return `${h}:${m.toString().padStart(2, '0')}`;
        };

        const getRecentShiftSummary = async (cid, name, forceThreshold = 300000) => {
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1;
            const shifts = await dataManager.getShifts(cid, year, month);
            const empShifts = shifts[name] || [];
            const lastShift = empShifts[empShifts.length - 1];

            if (lastShift && lastShift.end) {
                if (Date.now() - parseInt(lastShift.end) < forceThreshold) {
                    const bizConfig = await dataManager.getCompanyConfig(cid);
                    const holidayDates = await dataManager.getHolidayDatesForMonth(cid, year, month);
                    const shiftWage = WageCalculator.calculateBreakdown([lastShift], bizConfig.settings?.salary || {}, holidayDates);
                    return {
                        duration: calculateDuration(lastShift.start, lastShift.end),
                        weightedHours: formatHHMM(shiftWage.weightedTotal),
                        wageBreakdown: shiftWage.breakdown
                    };
                }
            }
            return null;
        };

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
                        // Fix: get latest employees list from dataManager directly
                        result.allEmployees = await dataManager.getEmployees(result.companyId).catch(() => []);
                        result.availableHolidays = await dataManager.getAvailableHolidays(result.companyId).catch(() => []);
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
                const active = !!(sysConfig.tranzilaTerminal && sysConfig.tranzilaPass && sysConfig.tranzilaPlans && sysConfig.tranzilaPlans.length > 0);
                return res.json({
                    success: true,
                    active,
                    adminWhatsapp: sysConfig.adminWhatsapp || '',
                    supportEnabled: sysConfig.supportEnabled === true,
                    plans: sysConfig.tranzilaPlans || []
                });
            }

            // === EMPLOYEE CHECKIN/OUT ===
            case 'checkIn':
            case 'checkOut': {
                const type = action === 'checkIn' ? 'IN' : 'OUT';
                const locationData = (rest.lat && rest.lng) ? { lat: rest.lat, lng: rest.lng } : null;
                const logRes = await dataManager.logShift(companyId, rest.name, type, Date.now(), locationData, rest.note, rest.deviceId);

                if (logRes && logRes.success === false) {
                    return res.json(logRes);
                }

                const status = await dataManager.getEmployeeStatus(companyId, rest.name);

                // Enriched summaries
                const monthlySummary = await getMonthlySummary(companyId, rest.name);
                const lastShiftSummary = type === 'OUT' ? await getRecentShiftSummary(companyId, rest.name, 60000) : null;

                return res.json({
                    success: true,
                    ...status,
                    message: type === 'IN' ? 'נכנסת בהצלחה' : 'יצאת בהצלחה',
                    monthlySummary,
                    lastShiftSummary
                });
            }

            case 'getStatus': {
                const status = await dataManager.getEmployeeStatus(companyId, rest.name);
                const monthlySummary = await getMonthlySummary(companyId, rest.name);
                const lastShiftSummary = status.state === 'OUT' ? await getRecentShiftSummary(companyId, rest.name) : null;
                return res.json({ success: true, ...status, monthlySummary, lastShiftSummary });
            }

            // === REPORTS ===
            case 'getYears': {
                const allYears = await dataManager.getHistoryYears(companyId);
                return res.json({ success: true, years: allYears });
            }

            case 'getMonths': {
                const allMonths = await dataManager.getHistoryMonths(companyId, rest.year);
                const months = allMonths.map(m => ({ name: m }));
                return res.json({ success: true, months });
            }

            case 'getReport': {
                let rawShifts = [];
                const localData = await dataManager.getShiftsHybrid(companyId, parseInt(rest.year), parseInt(rest.month));
                rawShifts = rest.name ? (localData[rest.name] || []) : [];

                // Try GAS if missing local or if it's a deep archive request
                if (rawShifts.length === 0) {
                    const bizConfig = await dataManager.getCompanyConfig(companyId);
                    const gasUrl = bizConfig.gasUrl || config.GAS_COLD_STORAGE_URL;
                    if (gasUrl) {
                        try {
                            console.log(`[API] Fetching GAS report for ${companyId}/${rest.year}/${rest.month} via ${gasUrl}`);
                            const gasRes = await axios.get(`${gasUrl}?action=getArchivedMonth&year=${rest.year}&month=${rest.month}&companyId=${companyId}&password=${bizConfig.password || ''}`, { timeout: 10000 });
                            console.log(`[API] GAS Report result success: ${gasRes.data?.success}`);

                            if (gasRes.data && gasRes.data.success) {
                                // GAS getArchivedMonth returns results in 'data' as stringified JSON
                                let shiftsData = gasRes.data.data;
                                if (typeof shiftsData === 'string') {
                                    try {
                                        shiftsData = JSON.parse(shiftsData);
                                    } catch (pe) {
                                        console.error('[API] Failed to parse shifts from GAS:', pe.message);
                                        shiftsData = {};
                                    }
                                }

                                if (rest.name) {
                                    rawShifts = shiftsData[rest.name] || [];
                                } else {
                                    // Handle cases where we might need all shifts (if applicable)
                                    rawShifts = [];
                                }
                            }
                        } catch (e) {
                            console.error('[GAS] getReport failed:', e.message);
                        }
                    }
                }

                const bizConfig = await dataManager.getCompanyConfig(companyId);
                const formattedShifts = rawShifts.map((s, idx) => {
                    const startDate = s.start ? new Date(parseInt(s.start) || s.start) : null;
                    const endDate = s.end ? new Date(parseInt(s.end) || s.end) : null;
                    const tz = 'Asia/Jerusalem';
                    const formatDate = d => d ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) : '';
                    const formatTime = d => d ? d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }) : '';

                    return {
                        rowIndex: idx,
                        _raw: s,
                        date: formatDate(startDate),
                        start: formatTime(startDate),
                        end: formatTime(endDate),
                        duration: calculateDuration(s.start, s.end),
                        startRaw: s.start,
                        endRaw: s.end,
                        location: s.location || (s.distance ? s.distance : '')
                    };
                });

                const holidayDates = await dataManager.getHolidayDatesForMonth(companyId, parseInt(rest.year), parseInt(rest.month));
                const wageResult = WageCalculator.calculateBreakdown(rawShifts, bizConfig.settings?.salary || {}, holidayDates);

                return res.json({
                    success: true,
                    shifts: formattedShifts,
                    holidayDates,
                    totalHours: formatHHMM(wageResult.totalHours),
                    weightedHours: formatHHMM(wageResult.weightedTotal),
                    wageBreakdown: wageResult.breakdown
                });
            }


            case 'getEmployeesForMonth': {
                let data = await dataManager.getShiftsHybrid(companyId, parseInt(rest.year), parseInt(rest.month));
                let employees = Object.keys(data).sort();

                // If no local data, try GAS cold storage
                if (employees.length === 0) {
                    const gasUrl = config.GAS_COLD_STORAGE_URL;
                    if (gasUrl) {
                        try {
                            const gasRes = await require('axios').get(
                                `${gasUrl}?action=getArchivedMonth&companyId=${companyId}&year=${rest.year}&month=${rest.month}`,
                                { timeout: 15000 }
                            );
                            if (gasRes.data && gasRes.data.success && gasRes.data.data) {
                                const parsed = typeof gasRes.data.data === 'string' ? JSON.parse(gasRes.data.data) : gasRes.data.data;
                                employees = Object.keys(parsed).sort();
                            }
                        } catch (e) {
                            console.warn('[getEmployeesForMonth] GAS fallback failed:', e.message);
                        }
                    }
                }

                return res.json({ success: true, employees });
            }

            // === ADMIN OPERATIONS ===
            case 'getDashboard': {
                const dashboard = await dataManager.getDashboard(companyId);
                const allEmployees = await dataManager.getEmployees(companyId).catch(() => []);
                return res.json({ success: true, dashboard, allEmployees });
            }

            case 'adminAddEmployee': {
                const addRes = await dataManager.addEmployee(companyId, rest.employeeName);
                if (!addRes.success) return res.json(addRes);

                // Refresh data for the client
                const allEmployees = await dataManager.getEmployees(companyId).catch(() => []);
                const dashboard = await dataManager.getDashboard(companyId).catch(() => []);
                return res.json({ success: true, allEmployees, dashboard });
            }

            case 'adminEmployee': {
                const { name, type: empAction } = rest;
                if (empAction === 'delete') {
                    await dataManager.deleteEmployee(companyId, name);
                } else {
                    await dataManager.addEmployee(companyId, name);
                }
                const allEmployees = await dataManager.getEmployees(companyId).catch(() => []);
                const dashboard = await dataManager.getDashboard(companyId).catch(() => []);
                return res.json({ success: true, allEmployees, dashboard });
            }

            case 'adminForceAction': {
                const fRes = await dataManager.adminForceAction(companyId, { name: rest.name, forceType: rest.forceType });
                const dashboard = await dataManager.getDashboard(companyId);
                return res.json({ success: true, dashboard, ...fRes });
            }

            case 'adminSaveShift': {
                if (!rest.year || isNaN(parseInt(rest.year)) || !rest.month || isNaN(parseInt(rest.month)) || !rest.name) {
                    return res.status(400).json({ success: false, error: 'Missing or invalid year/month/name' });
                }
                const sRes = await dataManager.adminSaveShift(companyId, {
                    year: rest.year,
                    month: rest.month,
                    name: rest.name,
                    originalStart: rest.originalStart || rest.start,
                    newStart: rest.start,
                    newEnd: rest.end
                });
                return res.json(sRes || { success: true });
            }

            case 'adminDeleteShift': {
                if (!rest.year || isNaN(parseInt(rest.year)) || !rest.month || isNaN(parseInt(rest.month)) || !rest.name) {
                    return res.status(400).json({ success: false, error: 'Missing or invalid year/month/name' });
                }
                const dRes = await dataManager.adminDeleteShift(companyId, {
                    year: rest.year,
                    month: rest.month,
                    name: rest.name,
                    start: rest.start
                });
                return res.json(dRes || { success: true });
            }

            case 'adminSendMonthlyReport': {
                const config = await dataManager.getCompanyConfig(companyId);
                const reportData = await dataManager.getShiftsHybrid(companyId, parseInt(rest.year), parseInt(rest.month));
                await emailService.sendMonthlyReport(config.adminEmail, reportData, parseInt(rest.year), parseInt(rest.month), config.businessName, config.settings?.salary || {}, companyId, config.logoUrl);

                // When finishing a month, trigger the garbage collection to purge old month files out of Render and push to GAS
                dataManager.archiveAndCleanup(companyId).catch(err => {
                    console.error(`[Archive] Background archive failed for ${companyId}:`, err);
                });

                return res.json({ success: true });
            }

            case 'adminExportFullHistory': {
                // Redirect to GAS cold storage for full export (Render only holds recent data)
                return res.json({ success: false, error: 'Use GAS export endpoint directly', redirectToGAS: true });
            }

            case 'getUserFullHistory': {
                const allData = await dataManager.getUserFullHistory(companyId, rest.name);
                return res.json({ success: true, shifts: allData });
            }

            // === SETTINGS ===
            case 'getAdminSettings': {
                const config = await dataManager.getCompanyConfig(companyId);
                const holidays = await dataManager.getAvailableHolidays(companyId).catch(() => []);
                const client = await dataManager.getClientById(companyId);

                const now = new Date();
                const expiry = client?.subscriptionExpiry ? new Date(client.subscriptionExpiry) : now;
                const isExpired = expiry < now;

                return res.json({
                    success: true,
                    settings: config?.settings || {},
                    adminEmail: config?.adminEmail || '',
                    supportPhone: config?.supportPhone || '',
                    availableHolidays: holidays,
                    paymentHistory: client?.paymentHistory || [],
                    expiryDate: client?.subscriptionExpiry,
                    isExpired: isExpired
                });
            }

            case 'saveAdminSettings': {
                await dataManager.saveAdminSettings(companyId, rest.settings, rest.adminEmail);
                return res.json({ success: true });
            }

            case 'adminSavePolygon': {
                await dataManager.savePolygon(companyId, rest.polygon);
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
                req.body.businessName = rest.businessName;
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
    try {
        const { password } = req.body;
        if (!isValidSuperAdminPassword(password)) {
            return res.status(401).json({ success: false, error: "Unauthorized" });
        }

        const businesses = await dataManager.getAllClientsWithStatus();
        res.json({
            success: true,
            businesses,
            gasUrl: config.GAS_COLD_STORAGE_URL || '' // Pass GAS URL for direct frontend contact
        });
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
                tranzilaPlans: config.tranzilaPlans || [],
                supportEnabled: config.supportEnabled || false
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/super-admin/settings/update', async (req, res) => {
    try {
        const { password, phone, tranzilaTerminal, tranzilaPass, tranzilaPlans, supportEnabled } = req.body;
        if (!isValidSuperAdminPassword(password)) return res.status(401).json({ success: false, error: "Unauthorized" });

        await dataManager.updateSystemConfig({
            adminWhatsapp: phone,
            tranzilaTerminal,
            tranzilaPass,
            tranzilaPlans,
            supportEnabled
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

router.post('/super-admin/sync', async (req, res) => {
    try {
        const { password } = req.body;
        if (!isValidSuperAdminPassword(password)) return res.status(401).json({ success: false, error: "Unauthorized" });

        const success = await dataManager.syncAllFromGAS();
        if (success) {
            res.json({ success: true, message: "Sync completed from GAS" });
        } else {
            res.json({ success: false, error: "Sync failed - check server logs" });
        }
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

        // Adjust subscription expiry using "2nd of the month" logic
        const now = new Date();
        const currentExpiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : now;

        let targetDate;
        if (currentExpiry < now) {
            // Expired: Start from the 2nd of the next month
            targetDate = new Date();
            targetDate.setMonth(targetDate.getMonth() + 1);
            targetDate.setDate(2);
        } else {
            // Active: Just use current expiry as base
            targetDate = new Date(currentExpiry);
        }

        // Add months (handle negative months for refund/shortening)
        targetDate.setMonth(targetDate.getMonth() + parseInt(months));

        // Always align to the 2nd
        targetDate.setDate(2);
        targetDate.setHours(23, 59, 59, 999);

        client.subscriptionExpiry = targetDate.toISOString();

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

        const result = await dataManager.logShift(companyId, userName, action, timestamp || Date.now(), location, note, req.body.deviceId);

        if (result && result.success === false) {
            return res.json(result);
        }

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

        // Calculate total hours from start/end timestamps (shift.duration field does not exist)
        let totalHours = 0;
        userShifts.forEach(shift => {
            if (shift.start && shift.end) {
                const startMs = parseInt(shift.start) || new Date(shift.start).getTime();
                const endMs = parseInt(shift.end) || new Date(shift.end).getTime();
                if (endMs > startMs) {
                    totalHours += (endMs - startMs) / 3600000; // milliseconds → hours
                }
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
        const bizConfig = await dataManager.getCompanyConfig(companyId);
        await emailService.sendMonthlyReport(client.email, reportData, year, month, client.businessName, bizConfig.salary, companyId, bizConfig.logoUrl);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// --- EXPORT ---

router.post('/admin/export', async (req, res) => {
    try {
        const { companyId } = req.body;
        const combined = await dataManager.getFullHistoryForExport(companyId);

        if (!combined || Object.keys(combined).length === 0) {
            return res.status(404).json({ success: false, error: 'No data found in GAS or local storage' });
        }

        return res.json({ success: true, data: combined });
    } catch (e) {
        console.error('[Export]', e);
        return res.status(500).json({ success: false, error: e.message });
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

// Route was removed due to duplication with the one
// Health Check
router.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date(), version: config.VERSION });
});

// Diagnostic Endpoint (Internal Use)
router.get('/diag', async (req, res) => {
    const holidays = await dataManager.getAvailableHolidays('diag_test').catch(e => e.message);
    res.json({
        nodeVersion: process.version,
        env: {
            NODE_ENV: process.env.NODE_ENV,
            GAS_URL: !!process.env.GAS_COLD_STORAGE_URL, // Sanitized
            DATA_DIR: process.env.DATA_DIR || './data'
        },
        config: {
            MAJOR_HOLIDAYS_LEN: (config.MAJOR_HOLIDAYS || []).length,
            GAS_COLD_STORAGE_URL: !!config.GAS_COLD_STORAGE_URL // Sanitized
        },
        testFetch: holidays
    });
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

        console.log(`[Payment] Starting process for company: ${companyId}, plan: ${planId}`);

        if (!cardInfo || !companyId || !planId) {
            return res.status(400).json({ success: false, error: 'Missing required fields: companyId, planId, or paymentDetails' });
        }

        // 1. Get System Config (Tranzila Credentials)
        const systemConfig = await dataManager.getSystemConfig();
        console.log('[Payment] System config loaded. Terminal:', systemConfig.tranzilaTerminal ? 'OK' : 'MISSING');

        if (!systemConfig.tranzilaTerminal || !systemConfig.tranzilaPass) {
            return res.status(500).json({ success: false, error: 'Payment Gateway not configured - tranzilaTerminal or tranzilaPass missing in system config' });
        }

        // 2. Resolve plan from system config (plans stored as tranzilaPlans)
        const allPlans = systemConfig.tranzilaPlans || systemConfig.plans || [];
        const selectedPlan = allPlans.find(p => String(p.id) === String(planId));

        let resolvedPrice = price;
        if (!resolvedPrice) {
            if (selectedPlan) {
                resolvedPrice = selectedPlan.price?.toString() || '0';
                console.log(`[Payment] Resolved price for plan ${planId}: ${resolvedPrice}`);
            } else {
                console.warn(`[Payment] Plan ${planId} not found in system config, using price: 0`);
                resolvedPrice = '0';
            }
        }

        // 3. Prepare Payload for JetServer Proxy EXACTLY like the simulator
        let mm, yy;
        if (cardInfo.expMonth && cardInfo.expYear) {
            mm = cardInfo.expMonth.toString().padStart(2, '0');
            yy = cardInfo.expYear.toString().padStart(4, '20'); // Ensure 4 digits
        } else if (cardInfo.expiry) {
            const parts = cardInfo.expiry.split('/');
            mm = (parts[0] || '').padStart(2, '0');
            yy = '20' + (parts[1] || '').slice(-2);
        } else {
            return res.status(400).json({ success: false, error: 'Missing credit card expiry (expMonth+expYear or expiry)' });
        }

        // 3a. Resolve business name (Priority: Request body > Config > Default)
        let businessName = req.body.businessName;

        // If not in body or if it's the system name "TempusGeo", try to fetch from config
        if (!businessName || businessName === 'TempusGeo') {
            try {
                const companyConfig = await dataManager.getCompanyConfig(companyId);
                businessName = companyConfig.businessName;
            } catch (e) {
                console.warn('[Payment] Could not fetch businessName from config:', e.message);
            }
        }

        // Final fallback if everything fails
        if (!businessName || businessName === 'TempusGeo') businessName = '';

        // 3b. Build proper plan description (REVERSED: Product is TenpusGeo)
        const planDesc = selectedPlan
            ? `TempusGeo - מנוי ל-${selectedPlan.months || 1} חודשים`
            : `TempusGeo - Plan ${planId}`;

        // 3d. Resolve ID (myid) - BE ROBUST
        // Priority: Explicit cardInfo.myid (from frontend) > fallbacks
        const myid = (
            cardInfo.myid ||
            cardInfo.cardId ||
            cardInfo.idNumber ||
            cardInfo.id ||
            cardInfo.businessId ||
            ''
        ).toString().trim();

        const payload = {
            terminalName: systemConfig.tranzilaTerminal,
            terminalPass: systemConfig.tranzilaPass,
            sum: resolvedPrice,
            ccno: cardInfo.cardNumber,
            expmonth: mm,
            expyear: yy,
            mycvv: cardInfo.cvv || '',
            // שם בעל הכרטיס (מהטופס) → contact
            contact: cardInfo.cardName || cardInfo.cardHolder || '',
            // שם העסק: אם המשתמש הזין טקסט בתיבת "פרטי עסק לחשבונית" נשתמש בו (businessId), אחרת שם העסק מהמערכת
            company: (cardInfo.businessId && cardInfo.businessId.trim()) ? cardInfo.businessId : businessName,
            // ח"פ / עוסק מורשה (מהטופס) → myid (לחשבונית)
            myid: myid,
            email: cardInfo.email || '',
            pdesc: planDesc,
            companyId: companyId
        };

        const payloadStr = JSON.stringify(payload);
        console.log(`[Payment] Resolved myid for proxy: ${myid}`);
        console.log('[Payment] Payload prepared (JSON):', payloadStr.replace(/"terminalPass":"[^"]+"/, '"terminalPass":"***"'));

        // 4. Send to JetServer Proxy
        const jetServerUrl = process.env.JETSERVER_PROXY_URL ||
            systemConfig.jetServerUrl || 'https://funz.co.il/TempusGeo/process_payment.php';

        console.log('[Payment] Sending to proxy:', jetServerUrl);

        const proxyRes = await fetch(jetServerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-jetserver-token': process.env.JETSERVER_TOKEN || 'SysToken_2026_TranzilaLink'
            },
            body: payloadStr
        });

        const rawText = await proxyRes.text();
        console.log('[Payment] Proxy HTTP status:', proxyRes.status);
        console.log('[Payment] Proxy raw response:', rawText);

        if (!proxyRes.ok) {
            return res.status(500).json({
                success: false,
                error: `Proxy server returned HTTP ${proxyRes.status}`,
                proxyResponse: rawText
            });
        }

        // Parse response
        let proxyData;
        try {
            proxyData = JSON.parse(rawText);
        } catch (e) {
            // PHP returned HTML error from Tranzila Direct
            if (rawText.toLowerCase().includes('amount zero') || rawText.toLowerCase().includes('error message')) {
                return res.json({ success: false, error: 'עסקה נדחתה: סכום שגוי (Amount Zero). אנא פנה לתמיכה.' });
            }

            const urlParams = new URLSearchParams(rawText);
            const responseCode = urlParams.get('Response');
            if (responseCode === '000') {
                const updatedClient = await dataManager.extendSubscription(companyId, planId, resolvedPrice);
                const newExpiry = updatedClient.subscriptionExpiry;
                console.log(`[Payment] Subscription extended for ${companyId}, new expiry: ${newExpiry}`);
                return res.json({ success: true, newExpiry, tranzilaResponse: Object.fromEntries(urlParams) });
            } else if (responseCode) {
                return res.json({
                    success: false,
                    error: `עסקה נדחתה קוד: ${responseCode} - ${urlParams.get('text') || 'סיבה לא ידועה'}`,
                    tranzilaResponse: Object.fromEntries(urlParams)
                });
            }
            // Unknown format
            return res.status(500).json({ success: false, error: 'Proxy returned HTML formatting error.', proxyResponse: rawText.substring(0, 100) });
        }

        // 5. Handle JSON response from our proxy
        if (proxyData.success) {
            const tranzilaParams = new URLSearchParams(proxyData.tranzila_raw || '');
            const responseCode = tranzilaParams.get('Response') || proxyData.responseCode;
            console.log('[Payment] Tranzila Response Code:', responseCode);

            if (responseCode === '000') {
                const updatedClient = await dataManager.extendSubscription(companyId, planId, resolvedPrice);
                const newExpiry = updatedClient.subscriptionExpiry;
                console.log(`[Payment] Subscription extended for ${companyId}, new expiry: ${newExpiry}`);
                return res.json({ success: true, newExpiry, tranzilaResponse: Object.fromEntries(tranzilaParams) });
            } else {
                if (proxyData.tranzila_raw && proxyData.tranzila_raw.toLowerCase().includes('amount zero')) {
                    return res.json({ success: false, error: 'עסקה נדחתה: סכום שגוי (Amount Zero) בטרנזילה.' });
                }

                return res.json({
                    success: false,
                    error: `עסקה נדחתה קוד: ${responseCode} - ${tranzilaParams.get('text') || proxyData.message || 'סיבה לא ידועה'}`,
                    tranzilaResponse: Object.fromEntries(tranzilaParams)
                });
            }
        } else {
            return res.status(500).json({ success: false, error: proxyData.error || proxyData.message || 'Proxy returned failure', proxyResponse: proxyData });
        }

    } catch (e) {
        console.error('[Payment] FATAL Error:', e);
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
                const bizConfig = await dataManager.getCompanyConfig(client.id);

                // Pass salary config for breakdown and companyId for holiday resolution
                await emailService.sendMonthlyReport(client.email, reportData, year, month, client.businessName, bizConfig.settings?.salary || {}, client.id, bizConfig.logoUrl);
                sent++;

                // Auto Archive past 30 days data to GAS
                console.log(`[Maintenance] Triggering Auto-Archive for ${client.id}`);
                await dataManager.archiveAndCleanup(client.id);

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

// Forced commit update to ensure file is pushed completely to Render

// Triggering Render upload update for SMTP TLS patch

// History Export Local Migration Patch
