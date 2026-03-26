const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const axios = require('axios');
const emailService = require('./EmailService');
const WageCalculator = require('./WageCalculator');
const syncManager = require('./SyncManager');
const tranzilaService = require('./TranzilaService');

// --- IN-MEMORY CACHE ---
// Structure: { companyId: { config: {}, shifts: { '2024-02': { ...data... } } } }
const CACHE = {
    clients: [], // Array of client objects
    companies: {},
    historicalData: {}, // Cache for cold data from GAS: { companyId: { 'year-month': data } }
    systemConfig: null
};

// HOT STORAGE CONFIG
const HOT_STORAGE_MONTHS = 2; // Keep current + last month

class DataManager {
    constructor() {
        this.dataDir = config.DATA_DIR;
        this.clientsFile = path.join(this.dataDir, 'clients.json');
        this.metadataFile = path.join(this.dataDir, 'metadata.json');
        this.maintenanceLogs = {
            CHECKOUT: [],
            BILLING: [],
            RENEWAL: [], // Category for subscription extensions/renewals
            REPORTS: [],
            SYSTEM: [],
            ERROR: []
        }; // RAM storage for live admin logs
        this.init();
    }

    logMaintenance(category, message, details = null) {
        const entry = {
            timestamp: new Date().toISOString(),
            category,
            message,
            details
        };
        
        // Ensure category exists
        if (!this.maintenanceLogs[category]) {
            this.maintenanceLogs[category] = [];
        }
        
        this.maintenanceLogs[category].unshift(entry);
        if (this.maintenanceLogs[category].length > 100) this.maintenanceLogs[category].pop(); // Keep last 100 as per user request
        
        // Also keep a global "all" log for compatibility/backup if needed, but let's stick to categories
        if (!this.maintenanceLogs.ALL) this.maintenanceLogs.ALL = [];
        this.maintenanceLogs.ALL.unshift(entry);
        if (this.maintenanceLogs.ALL.length > 500) this.maintenanceLogs.ALL.pop();

        // Log to console as well
        console.log(`[Maintenance][${category}] ${message}`, details ? details : '');
    }

    parseExpiryDate(expiry) {
        if (!expiry) return new Date(0);
        if (expiry instanceof Date) return expiry;
        if (expiry === "Unlimited") return new Date(8640000000000000); // Far future

        if (typeof expiry === 'string' && (expiry.includes('/') || expiry.includes('.') || expiry.includes('-'))) {
            const parts = expiry.split(/[./-]/);
            if (parts.length === 3) {
                if (parts[0].length === 4) { // YYYY-MM-DD
                    return new Date(expiry);
                } else { // DD.MM.YYYY or DD/MM/YYYY
                    return new Date(parts[2], parts[1] - 1, parts[0]);
                }
            }
        }
        return new Date(expiry);
    }

    async updateLastWriteTime() {
        const timestamp = Date.now();
        try {
            await fs.writeFile(this.metadataFile, JSON.stringify({ lastWriteTime: timestamp }));
        } catch (e) {
            console.error('[Metadata] Failed to write metadata:', e);
        }
        return timestamp;
    }

    async getLastWriteTime() {
        try {
            const data = await fs.readFile(this.metadataFile, 'utf8');
            return JSON.parse(data).lastWriteTime || 0;
        } catch (e) {
            return 0;
        }
    }

    async init() {
        try {
            // Ensure Data Directory Exists
            await fs.mkdir(this.dataDir, { recursive: true });

            // 1. Load Local Clients
            try {
                const data = await fs.readFile(this.clientsFile, 'utf8');
                CACHE.clients = JSON.parse(data);
                console.log(`Loaded ${CACHE.clients.length} clients from disk.`);
            } catch (e) {
                console.log("No clients.json found. Creating new empty DB (temporarily).");
                CACHE.clients = [];
            }

            // 2. Load Local Metadata
            const localTime = await this.getLastWriteTime();
            console.log(`[Init] Local Data Timestamp: ${new Date(localTime).toISOString()}`);

            // 3. Check GAS for Updates / Restore (Smart Sync)
            // We always check GAS on startup to see if we are stale (e.g. reverted to old snapshot)
            console.log(`[Init] Checking for cloud restore/sync... (Local: ${localTime})`);
            const syncSuccess = await this.smartRestoreFromGAS(localTime);
            if (!syncSuccess) {
                console.warn("[Init] Cloud sync failed or skipped. Continuing with local data.");
            }

            // 4. Discovery: Search for "Orphan" directories and reconcile them to clients.json
            await this.discoverAndReconcileOrphans();

            // 5. Cleanup: If __SYSTEM__ somehow slipped into clients, remove it
            CACHE.clients = CACHE.clients.filter(c => c.id !== '__SYSTEM__');

            // 5. Load All Companies into RAM (Warmup)
            for (const client of CACHE.clients) {
                await this.loadCompany(client.id);
            }

            // 6. Proactive Metadata Recovery: Sync missing history filters from GAS
            this.ensureAllBusinessesHaveMetadata().catch(err => {
                console.error(`[Metadata-Sync] Global sync failed:`, err.message);
            });

            // 5. Start Automatic Maintenance Tasks
            setInterval(async () => {
                const sysConfig = await this.getSystemConfig();
                const freq = parseInt(sysConfig.shiftCheckFrequency) || 0.5; // default 0.5 min = 30s
                
                // If freq is 0, disable auto-check
                if (freq <= 0) return;

                const now = Date.now();
                if (!this._lastAutoCheckout || (now - this._lastAutoCheckout) >= (freq * 60 * 1000)) {
                    this._lastAutoCheckout = now;
                    this.performAutoCheckout().catch(e => console.error(`[Auto-Checkout] Failed:`, e.message));
                }
            }, 30 * 1000); // Check every 30s if it's time to run

            // 6. Start Daily Cleanup & Archive Trigger (Every 24 hours)
            setInterval(() => {
                this.runGlobalArchiveCycle().catch(e => console.error(`[Auto-Archive] Global Cycle Failed:`, e.message));
            }, 24 * 60 * 60 * 1000);

            // 7. Start Automatic Recurring Payment Cycle (Every 1 hour check)
            setInterval(() => {
                this.checkSubscriptions().catch(e => console.error(`[Auto-Billing-Check] Failed:`, e.message));
            }, 60 * 60 * 1000);

            // 8. Monthly Reports Scheduler (Check every hour)
            setInterval(async () => {
                const now = new Date();
                const sysConfig = await this.getSystemConfig();
                const targetDay = parseInt(sysConfig.monthlyReportDay) || 1;
                const [targetH, targetM] = (sysConfig.monthlyReportHour || "09:00").split(':').map(Number);

                if (now.getDate() === targetDay && now.getHours() === targetH) {
                    // Prevent double run in same hour
                    const runKey = `reports-${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
                    if (this._lastReportRun !== runKey) {
                        this._lastReportRun = runKey;
                        this.runMonthlyReports().catch(e => console.error(`[Monthly-Reports] Scheduler Failed:`, e.message));
                    }
                }
            }, 60 * 60 * 1000);

            // Trigger once on startup after 1 minute for immediate status check
            setTimeout(async () => {
                this.logMaintenance('SYSTEM', 'Startup maintenance sequence successful.');

                // Push system config to EmailService to ensure correct sender names
                try {
                    const systemConfig = await this.getSystemConfig();
                    if (emailService && emailService.setSystemConfig) {
                        emailService.setSystemConfig(systemConfig);
                    }
                } catch (err) {
                    console.error('[DataManager] Failed to sync config to EmailService on startup:', err.message);
                }

                this.performAutoCheckout().catch(e => console.error(`[Startup Auto-Checkout] Failed:`, e.message));
                this.checkSubscriptions().catch(e => console.error(`[Startup Sub-Check] Failed:`, e.message));
                
                // Global Archive Cycle replacement:
                for (const client of CACHE.clients) {
                    this.archiveAndCleanup(client.id).catch(e => console.error(`[Startup Clean] Failed for ${client.id}:`, e.message));
                }
            }, 10000); // 10s after boot

        } catch (e) {
            console.error("Critical Error initializing DataManager:", e);
        }
    }

    // --- CLIENTS / AUTH ---

    async getClientById(id) {
        return CACHE.clients.find(c => c.id === id);
    }

    async getAllClients() {
        return CACHE.clients;
    }

    async saveClients() {
        await fs.writeFile(this.clientsFile, JSON.stringify(CACHE.clients, null, 2));
        await this.updateLastWriteTime();

        // Sync clients.json to GAS for persistence across Render restarts
        const gasUrl = config.GAS_COLD_STORAGE_URL;
        if (gasUrl) {
            // Fix: Use a proper password (from env or default) to ensure GAS accepts the archive
            const adminPass = process.env.SUPER_ADMIN_PASS || '123456';
            syncManager.enqueue('CLIENTS', CACHE.clients, { companyId: '__SYSTEM__', gasUrl, password: adminPass });
        }
    }

    async saveClientPaymentMethod(companyId, paymentMethod) {
        const client = await this.getClientById(companyId);
        if (!client) throw new Error("Client not found");

        // Store inclusive of businessId (for automated billing receipts)
        client.paymentMethod = paymentMethod;
        
        client.autoChargeEnabled = true; // Auto-enable on card save
        await this.saveClients();

        if (paymentMethod.businessId) {
            await this.updateCompanyConfig(companyId, { invoiceDetails: paymentMethod.businessId });
        }
    }

    /**
     * Proactively scans for company directories that aren't in clients.json
     * and attempts to restore them.
     */
    async discoverAndReconcileOrphans() {
        console.log("[Orphan-Discovery] Scanning for ghost businesses...");
        const companiesDir = path.join(this.dataDir, 'companies');

        try {
            await fs.mkdir(companiesDir, { recursive: true });
            const folders = await fs.readdir(companiesDir);
            let foundNew = false;

            for (const companyId of folders) {
                // Check if folder is in CACHE.clients OR is a protected internal folder
                const existsInMaster = CACHE.clients.some(c => c.id === companyId);
                const isInternal = companyId.startsWith('__') || companyId === 'NEW_SETUP'; // Ignore __SYSTEM__, NEW_SETUP, etc.

                if (!existsInMaster && !isInternal) {
                    console.log(`[Orphan-Discovery] Found ghost client: ${companyId}. Attempting reconciliation...`);

                    try {
                        const configFile = path.join(companiesDir, companyId, 'config.json');
                        const data = await fs.readFile(configFile, 'utf8');
                        const config = JSON.parse(data);

                        // Construct a basic client entry from the config
                        const newClient = {
                            id: companyId,
                            businessName: `עסק חדש - קוד ${companyId}`,
                            email: config.adminEmail || "",
                            password: config.password || "1234", // Fallback if missing, though usually in config
                            subscriptionExpiry: config.subscriptionExpiry || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                            role: 'admin',
                            isOrphan: true // Flag for UI highlighting
                        };

                        CACHE.clients.push(newClient);
                        foundNew = true;
                        console.log(`[Orphan-Discovery] ג… Successfully reconciled: ${newClient.businessName}`);
                    } catch (err) {
                        console.error(`[Orphan-Discovery] ג Failed to reconcile ${companyId}:`, err.message);
                    }
                }
            }

            if (foundNew) {
                console.log("[Orphan-Discovery] Saving updated clients.json...");
                await this.saveClients();
            } else {
                console.log("[Orphan-Discovery] No orphans found.");
            }
        } catch (e) {
            console.error("[Orphan-Discovery] Discovery cycle failed:", e.message);
        }
    }

    // --- COMPANY DATA ---

    async loadCompany(companyId) {
        if (CACHE.companies[companyId]) return; // Already loaded

        const companyDir = path.join(this.dataDir, 'companies', companyId);
        await fs.mkdir(companyDir, { recursive: true });

        // Load Config
        let configData = {};
        try {
            const configFile = path.join(companyDir, 'config.json');
            const data = await fs.readFile(configFile, 'utf8');
            configData = JSON.parse(data);
        } catch (e) {
            console.log(`No config for ${companyId}, using defaults.`);
            configData = { companyId, settings: {} };
        }

        // Ensure Config has employees array
        if (!configData.employees) {
            configData.employees = [];
        }

        // Ensure Config has structures
        if (!configData.settings) configData.settings = {};
        if (!configData.settings.salary) configData.settings.salary = {};
        if (!configData.settings.salary.holidays) configData.settings.salary.holidays = {};
        if (!configData.settings.salary.holidays.eligible) configData.settings.salary.holidays.eligible = [];

        CACHE.companies[companyId] = {
            config: configData,
            shifts: {}, // Will load shifts on demand per month
            metadata: configData.historyMetadata || { years: {} },
            holidays: null,
            holidaysLastFetch: 0
        };

        // Background Refresh
        this.refreshMetadata(companyId).catch(() => { });
    }


    async getCompanyConfig(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const config = { ...CACHE.companies[companyId].config };

        // DYNAMICALLY INJECT SUBSCRIPTION STATUS AND BUSINESS NAME
        // This overrides any stale data in the config file
        const client = await this.getClientById(companyId);
        if (client) {
            const now = new Date();
            const expiry = this.parseExpiryDate(client.subscriptionExpiry || client.expiryDate);

            config.subscriptionExpired = expiry < now;
            config.expiryDate = expiry.toLocaleDateString('he-IL');

            // Fix: Always use the master businessName from clients.json if available
            if (client.businessName) {
                config.businessName = client.businessName;
            }
        }

        return config;
    }

    async getAllClientsWithStatus() {
        const now = new Date();
        const gasUrl = config.GAS_COLD_STORAGE_URL;
        let gasCompanies = new Set();
        let gasClientsMap = new Map(); // Store clients from GAS backup

        // 1. Fetch Cloud Data manifest (clients + presence)
        if (gasUrl) {
            try {
                // Requesting 'restore' but hopefully summary/manifest if supported
                const response = await axios.get(`${gasUrl}?path=restore`, { timeout: 20000 });
                if (response.data && response.data.success && response.data.data && Array.isArray(response.data.data.files)) {
                    const files = response.data.data.files;

                    // Look for clients.json content in the backup
                    const clientsFile = files.find(f => f.path === 'clients.json');
                    if (clientsFile && Array.isArray(clientsFile.content)) {
                        clientsFile.content.forEach(c => {
                            gasClientsMap.set(c.id, c);
                            gasCompanies.add(c.id);
                        });
                    }

                    // Also check for company folders presence in case clients.json is stale
                    files.forEach(f => {
                        const match = f.path.match(/^companies\/([^\/]+)\//);
                        if (match) gasCompanies.add(match[1]);
                    });
                }
            } catch (e) {
                console.error('[DataManager] Failed to merge GAS clients:', e.message);
            }
        }

        // 2. Merge local CACHE.clients with GAS clients (GAS is source of truth for "All Businesses")
        const mergedClientsMap = new Map();

        // Add local ones first
        CACHE.clients.forEach(c => mergedClientsMap.set(c.id, { ...c, source: 'local' }));

        // Add cloud ones if missing locally
        gasClientsMap.forEach((c, id) => {
            if (!mergedClientsMap.has(id)) {
                mergedClientsMap.set(id, { ...c, source: 'gas' });
            }
        });

        const mergedList = Array.from(mergedClientsMap.values());

        // 3. Enrich with status
        return Promise.all(mergedList.map(async (client) => {
            const expiry = this.parseExpiryDate(client.subscriptionExpiry || client.expiryDate);
            const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
            const isExpired = expiry < now;

            // Check local existence on disk
            const companyDir = path.join(this.dataDir, 'companies', client.id);
            let existsLocally = false;
            try {
                const stat = await fs.stat(companyDir);
                existsLocally = stat.isDirectory();
            } catch (e) { }

            // New: Active Employees & Expected Payment
            let activeEmployees = 0;
            let expectedPayment = { amount: 0, breakdown: {} };
            let freezeAmount = { amount: 0, breakdown: {} };
            
            if (existsLocally) {
                activeEmployees = await this.countUniqueActiveEmployees(client.id);
                expectedPayment = await this.calculateSubscriptionAmount(client.id);
                freezeAmount = await this.calculateFreezeAmount(client.id);
            }

            return {
                companyId: client.id,
                businessName: client.businessName || "עסק ללא שם",
                email: client.email || '',
                phone: client.phone || '',
                subscriptionExpiry: client.subscriptionExpiry,
                expiryDate: expiry.toLocaleDateString('he-IL'),
                isExpired: isExpired,
                daysRemaining: daysRemaining,
                existsLocally,
                existsInGAS: gasCompanies.has(client.id),
                isOrphan: gasCompanies.has(client.id) && !client.exists,
                activeEmployees,
                expectedPayment,
                freezeAmount,
                autoChargeEnabled: !!client.autoChargeEnabled,
                paymentHistory: client.paymentHistory || [],
                paymentMethod: client.paymentMethod || null
            };
        }));
    }

    async countUniqueActiveEmployees(companyId, year = null, month = null) {
        try {
            const now = new Date();
            const activeSet = new Set();
            
            let targetYear, targetMonth;

            if (year !== null && month !== null) {
                targetYear = year;
                targetMonth = month;
            } else {
                const sysConfig = await this.getSystemConfig();
                const chargeDay = parseInt(sysConfig.chargeDay) || 1;
                const chargeTime = sysConfig.chargeTime || "00:00";
                const nextCycle = this.getNextBillingDate();
                
                // The month to count for is the calendar month before the next cycle
                const targetDate = new Date(nextCycle);
                targetDate.setMonth(targetDate.getMonth() - 1);
                targetYear = targetDate.getFullYear();
                targetMonth = targetDate.getMonth() + 1;
            }

            const shifts = await this.getShifts(companyId, targetYear, targetMonth);
            const employees = Object.keys(shifts);

            employees.forEach(emp => {
                const empShifts = shifts[emp] || [];
                if (empShifts.length > 0) {
                    // Just having at least one shift in this month is enough
                    activeSet.add(emp);
                }
            });

            this.logMaintenance('DEBUG', `[Billing] Counted ${activeSet.size} active employees for ${companyId} in ${targetYear}-${targetMonth}.`);
            return activeSet.size;
        } catch (e) {
            this.logMaintenance('ERROR', `[DataManager] Failed to count active employees for ${companyId}: ${e.message}`);
            return 0;
        }
    }

    async calculateSubscriptionAmount(companyId, forcedEmployeeCount = null) {
        try {
            const client = await this.getClientById(companyId);
            if (!client) return { amount: 0, breakdown: {} };

            const sysConfig = await this.getSystemConfig();
            const minPrice = parseFloat(sysConfig.minMonthlyPrice) || 0;
            const pricePerEmp = parseFloat(sysConfig.pricePerEmployee) || 0;


            const nextCycle = this.getNextBillingDate();
            const targetDate = new Date(nextCycle);
            targetDate.setMonth(targetDate.getMonth() - 1);
            const targetYear = targetDate.getFullYear();
            const targetMonth = targetDate.getMonth();
            
            const LastMonthDays = new Date(targetYear, targetMonth + 1, 0).getDate();
            const employeeCount = forcedEmployeeCount !== null ? forcedEmployeeCount : await this.countUniqueActiveEmployees(companyId, targetYear, targetMonth + 1);

            const subscriptionDate = client.subscriptionDate ? new Date(client.subscriptionDate) : (client.joinedAt ? new Date(client.joinedAt) : new Date());

            let SubscriptionDaysInLastMonth = 0;
            if (subscriptionDate.getFullYear() === targetYear && subscriptionDate.getMonth() === targetMonth) {
                SubscriptionDaysInLastMonth = Math.max(0, LastMonthDays - subscriptionDate.getDate());
            } else if (subscriptionDate < new Date(targetYear, targetMonth, 1)) {
                SubscriptionDaysInLastMonth = LastMonthDays;
            } else {
                SubscriptionDaysInLastMonth = 0;
            }

            if (SubscriptionDaysInLastMonth <= 0 || LastMonthDays === 0) {
                return { 
                    amount: 0, 
                    breakdown: { 
                        employeeCount, pricePerEmp, minPrice, LastMonthDays, SubscriptionDaysInLastMonth, 
                        subscriptionDate: subscriptionDate.toISOString().split('T')[0],
                        periodGoal: `${targetYear}-${(targetMonth + 1).toString().padStart(2, '0')}`
                    }
                };
            }

            const formulaBase = Math.max(minPrice, employeeCount * pricePerEmp);
            const amount = Math.floor(formulaBase * (SubscriptionDaysInLastMonth / LastMonthDays));

            return {
                amount,
                breakdown: {
                    employeeCount,
                    pricePerEmp,
                    minPrice,
                    formulaBase,
                    LastMonthDays,
                    SubscriptionDaysInLastMonth,
                    subscriptionDate: subscriptionDate.toISOString().split('T')[0],
                    periodGoal: `${targetYear}-${(targetMonth + 1).toString().padStart(2, '0')}`
                }
            };
        } catch (e) {
            console.error('[Billing] calculateSubscriptionAmount error:', e.message);
            return { amount: 0, breakdown: { error: e.message } };
        }
    }

    async calculateFreezeAmount(companyId) {
        try {
            const client = await this.getClientById(companyId);
            if (!client) return { amount: 0, breakdown: {} };

            const sysConfig = await this.getSystemConfig();
            const minPrice = parseFloat(sysConfig.minMonthlyPrice) || 0;
            const pricePerEmp = parseFloat(sysConfig.pricePerEmployee) || 0;

            const now = new Date();
            const targetYear = now.getFullYear();
            const targetMonth = now.getMonth();

            const lastDayOfMonth = new Date(targetYear, targetMonth + 1, 0).getDate();
            const employeeCount = await this.countUniqueActiveEmployees(companyId, targetYear, targetMonth + 1);

            const subscriptionDate = client.subscriptionDate ? new Date(client.subscriptionDate) : (client.joinedAt ? new Date(client.joinedAt) : new Date());

            let activeDays = 0;
            if (subscriptionDate.getFullYear() === targetYear && subscriptionDate.getMonth() === targetMonth) {
                activeDays = Math.max(0, now.getDate() - subscriptionDate.getDate() + 1);
            } else if (subscriptionDate < new Date(targetYear, targetMonth, 1)) {
                activeDays = now.getDate();
            }

            const breakdown = {
                employeeCount,
                pricePerEmp,
                minPrice,
                lastDayOfMonth,
                activeDays,
                subscriptionDate: subscriptionDate.toISOString().split('T')[0],
                freezeDate: now.toISOString().split('T')[0]
            };

            if (activeDays <= 0 || lastDayOfMonth === 0) return { amount: 0, breakdown };

            const formulaBase = Math.max(minPrice, employeeCount * pricePerEmp);
            const amount = Math.floor(formulaBase * (activeDays / lastDayOfMonth));

            return { amount, breakdown: { ...breakdown, formulaBase } };
        } catch (e) {
            console.error('[Billing] calculateFreezeAmount error:', e.message);
            return { amount: 0, breakdown: { error: e.message } };
        }
    }


    /**
     * Returns the next billing date (Date object) based on the configured charge day and time.
     * If today is before the charge time on the charge day, returns today at charge time.
     * Otherwise returns the charge day/time in the next month.
     */
    /**
     * Always returns the 1st of the next month at 04:00 AM Israel Time.
     * This is now the rigid system standard.
     */
    getNextBillingDate() {
        const now = new Date();
        // Move to the 1st of NEXT month (or current month if it's before the 1st @ 04:00, but usually we just want next cycle)
        const target = new Date(now.getFullYear(), now.getMonth() + 1, 1, 4, 0, 0, 0);
        return target;
    }

    // legacy checkAndProcessAutoCharge and processAutoChargeCycle removed.
    // All automated logic is now unified in checkSubscriptions() which runs hourly.


    async syncAllFromGAS() {
        console.log('[DataManager] Forcing full sync from GAS (Ignored local timestamp)');
        return await this.smartRestoreFromGAS(0);
    }

    async updateAutoCharge(companyId, enabled) {
        const client = await this.getClientById(companyId);
        if (!client) throw new Error("Client not found");
        client.autoChargeEnabled = !!enabled;
        await this.saveClients();
    }

    async updateCompanyConfig(companyId, newConfig) {
        if (!companyId || companyId === 'NEW_SETUP') return; // Prevent ghost company creation
        
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        // Merge deep
        const current = CACHE.companies[companyId].config;

        // Specific logic for salary/constraints/adminEmail
        // merge everything passed in 'newConfig'
        const updated = { ...current, ...newConfig };

        // RAM Update
        CACHE.companies[companyId].config = updated;

        // Disk Update
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        await fs.mkdir(companyDir, { recursive: true });
        await fs.writeFile(path.join(companyDir, 'config.json'), JSON.stringify(updated, null, 2));
        await this.updateLastWriteTime();

        // ASYNC: Push to GAS in background
        const gasUrl = updated.gasUrl || config.GAS_COLD_STORAGE_URL;
        if (gasUrl) {
            syncManager.enqueue('CONFIG', updated, { companyId, gasUrl, password: updated.password });
        }

        return updated;
    }

    async savePolygon(companyId, polygon) {
        return await this.updateCompanyConfig(companyId, { polygon });
    }

    async saveAdminSettings(companyId, settings, adminEmail) {
        const updates = { settings };
        if (adminEmail) updates.adminEmail = adminEmail;
        return await this.updateCompanyConfig(companyId, updates);
    }

    // --- SYSTEM CONFIG (Global) ---
    async getSystemConfig() {
        return this.getSystemConfigSync();
    }

    getSystemConfigSync() {
        const configFile = path.join(this.dataDir, 'system_config.json');
        try {
            // Using require or synchronous read is tricky in async environment,
            // but for system config it's small. Let's use a cached version.
            if (this._systemConfig) return this._systemConfig;
            
            const fsSync = require('fs');
            if (!fsSync.existsSync(configFile)) return {};
            const data = fsSync.readFileSync(configFile, 'utf8');
            const parsed = JSON.parse(data);

            const allowedKeys = [
                'adminWhatsapp', 'tranzilaTerminal', 'tranzilaPass',
                'minMonthlyPrice', 'pricePerEmployee', 'chargeDay', 'chargeTime',
                'maxShiftHours', 'supportEnabled', 'appName', 'appLogoUrl',
                'subscriptionExpiryNotice', 'shiftCheckFrequency', 'monthlyReportDay', 'monthlyReportHour',
                'autoBillingEnabled', 'autoRenewalEnabled'
            ];
            const cleaned = {};
            allowedKeys.forEach(k => { if (parsed[k] !== undefined) cleaned[k] = parsed[k]; });
            this._systemConfig = cleaned;
            return cleaned;
        } catch (e) {
            return {};
        }
    }

    async updateSystemConfig(newConfig) {
        const current = await this.getSystemConfig();
        
        // --- CLEAN TRASH / GARBAGE COLLECTION ---
        // Explicit whitelist of allowed system configuration keys
        const allowedKeys = [
            'adminWhatsapp', 'tranzilaTerminal', 'tranzilaPass',
            'minMonthlyPrice', 'pricePerEmployee', 'chargeDay', 'chargeTime',
            'maxShiftHours', 'supportEnabled', 'appName', 'appLogoUrl',
            'subscriptionExpiryNotice', 'shiftCheckFrequency', 'monthlyReportDay', 'monthlyReportHour',
            'autoBillingEnabled', 'autoRenewalEnabled'
        ];

        // 1. Filter existing config to keep only allowed keys (Cleaning Trash)
        const cleanedCurrent = {};
        allowedKeys.forEach(key => {
            if (current[key] !== undefined) cleanedCurrent[key] = current[key];
        });

        // 2. Merge with new values (also filtered by whitelist)
        const updated = { ...cleanedCurrent };
        Object.keys(newConfig).forEach(key => {
            if (allowedKeys.includes(key)) {
                updated[key] = newConfig[key];
            }
        });

        console.log(`[DataManager] Final system configuration to save:`, JSON.stringify(updated));

        this._systemConfig = updated; // Update cache

        // Sync with EmailService
        if (emailService && emailService.setSystemConfig) {
            emailService.setSystemConfig(updated);
        }
        
        const configFile = path.join(this.dataDir, 'system_config.json');
        await fs.mkdir(this.dataDir, { recursive: true });
        await fs.writeFile(configFile, JSON.stringify(updated, null, 2));
        const timestamp = await this.updateLastWriteTime();

        // Push to GAS synchronously to ensure it's saved before returning to Admin
        const gasUrl = config.GAS_COLD_STORAGE_URL;
        if (gasUrl) {
            try {
                console.log('[DataManager] Syncing System Config to GAS...');
                await syncManager.syncNow('CONFIG', updated, { 
                    companyId: '__SYSTEM__', 
                    gasUrl, 
                    password: process.env.SUPER_ADMIN_PASS || '123456'
                });
                console.log('[DataManager] System Config synced to GAS successfully.');
            } catch (e) {
                console.error('[DataManager] Failed to sync System Config to GAS:', e.message);
                // Critical: Throw error back to API so user knows GAS failed
                throw new Error(`שמירה מקומית הצליחה אך הסנכרון לענן (GAS) נכשל: ${e.message}`);
            }
        }

        return updated;
    }

    // --- SHIFTS & ATTENDANCE ---

    async getShifts(companyId, year, month) {
        // key format: '2024-01'
        // Actually, let's stick to the "Year" folder structure to match GAS.

        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const cacheKey = `${year}-${month}`; // e.g., 2024-1 (January)

        if (CACHE.companies[companyId].shifts[cacheKey]) {
            return CACHE.companies[companyId].shifts[cacheKey];
        }

        // Load from Disk
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        const yearDir = path.join(companyDir, year.toString());

        let shifts = {};
        try {
            // Check both naming conventions. Default is X.json, GAS is json.X
            let filePath = path.join(yearDir, `${month}.json`);
            let fileData = null;

            try {
                fileData = await fs.readFile(filePath, 'utf8');
            } catch (e1) {
                // If X.json doesn't exist, try json.X
                filePath = path.join(yearDir, `json.${month}`);
                try {
                    fileData = await fs.readFile(filePath, 'utf8');
                } catch (e2) {
                    // Neither exists. File doesn't exist yet.
                }
            }

            if (fileData) {
                shifts = JSON.parse(fileData);
            }
        } catch (e) {
            shifts = {};
        }

        // Store in RAM
        CACHE.companies[companyId].shifts[cacheKey] = shifts;
        return shifts;
    }

    async saveShifts(companyId, year, month, shiftsData) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const cacheKey = `${year}-${month}`;
        CACHE.companies[companyId].shifts[cacheKey] = shiftsData;

        // Persist
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        const yearDir = path.join(companyDir, year.toString());
        await fs.mkdir(yearDir, { recursive: true });

        // Prefer existing format, defaults to X.json
        let targetFilePath = path.join(yearDir, `${month}.json`);
        try {
            await fs.access(path.join(yearDir, `json.${month}`));
            // If json.X exists but X.json doesn't, overwrite json.X
            try { await fs.access(targetFilePath); }
            catch { targetFilePath = path.join(yearDir, `json.${month}`); }
        } catch (e) { }

        await fs.writeFile(targetFilePath, JSON.stringify(shiftsData, null, 2));
        await this.updateLastWriteTime();

        // Update local metadata cache (Instant UI update)
        if (CACHE.companies[companyId]) {
            if (!CACHE.companies[companyId].metadata) CACHE.companies[companyId].metadata = { years: {} };
            if (!CACHE.companies[companyId].metadata.years[year.toString()]) {
                CACHE.companies[companyId].metadata.years[year.toString()] = [];
            }
            if (!CACHE.companies[companyId].metadata.years[year.toString()].includes(parseInt(month))) {
                CACHE.companies[companyId].metadata.years[year.toString()].push(parseInt(month));
                CACHE.companies[companyId].metadata.years[year.toString()].sort((a, b) => b - a);
                // Also update the persistent config
                const currentConfig = CACHE.companies[companyId].config;
                currentConfig.historyMetadata = CACHE.companies[companyId].metadata;
                await fs.writeFile(path.join(this.dataDir, 'companies', companyId, 'config.json'), JSON.stringify(currentConfig, null, 2));
            }
        }

        // ASYNC: Push to GAS in background
        const bizConfig = await this.getCompanyConfig(companyId);
        const gasUrl = bizConfig.gasUrl || config.GAS_COLD_STORAGE_URL;
        if (gasUrl) {
            syncManager.enqueue('SHIFT', { year, month, shifts: shiftsData }, { companyId, gasUrl, password: bizConfig.password });
        }
    }


    async getEmployeeStatus(companyId, employeeName) {
        // Fast RAM lookup
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        // --- AUTHORIZATION CHECK ---
        const config = await this.getCompanyConfig(companyId);
        const employees = config.employees || [];
        if (!employees.includes(employeeName)) {
            return { state: "UNAUTHORIZED", message: "שם העובד שהזנת אינו רשום במערכת. אנא פנה למנהל להוספה." };
        }

        // --- LAZY CHECK: Auto-Close if limit reached ---
        await this.checkAndApplyAutoCheckout(companyId, employeeName);

        // We need to check today's shift
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const shifts = await this.getShifts(companyId, year, month);

        // Check if employee has an open shift in current month
        const empShifts = shifts[employeeName] || [];
        const lastShift = empShifts[empShifts.length - 1];

        // Fetch company config to check for hybrid status
        // Reuse the 'config' variable declared above (line 886)
        const settings = config.settings || {};
        const isHybrid = settings.constraints && settings.constraints[employeeName] && settings.constraints[employeeName].isHybrid ? true : false;

        if (lastShift && !lastShift.end) {
            return { state: "IN", startTime: lastShift.start, isHybrid };
        }

        return { state: "OUT", isHybrid };
    }

    /**
     * Lazy check for a specific employee. Closes their shift retroactively if limit reached.
     */
    async checkAndApplyAutoCheckout(companyId, employeeName) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;

        const companyConfig = await this.getCompanyConfig(companyId);
        const constraints = companyConfig?.settings?.constraints || {};
        const userConstraint = constraints[employeeName] || {};

        const shiftsData = await this.getShifts(companyId, year, month);
        const empShifts = shiftsData[employeeName] || [];
        const lastShift = empShifts[empShifts.length - 1];

        if (lastShift && !lastShift.end && lastShift.start) {
            const startTime = new Date(parseInt(lastShift.start) || lastShift.start);
            const durationHours = (now.getTime() - startTime.getTime()) / 3600000;

            const hasCustomRule = !!userConstraint.maxDuration;
            const maxHours = hasCustomRule ? parseFloat(userConstraint.maxDuration) : 12;
            const enableAutoOut = hasCustomRule ? (userConstraint.enableAutoOut === true) : true;
            const enableAlert = userConstraint.enableAlert === true;

            if (durationHours > maxHours) {
                if (enableAutoOut) {
                    lastShift.end = new Date(startTime.getTime() + maxHours * 3600000).getTime();
                    lastShift.note = (lastShift.note || "") + ` [Auto-Checkout: ${maxHours}h limit]`;

                    await this.saveShifts(companyId, year, month, shiftsData);

                    if (enableAlert && companyConfig.adminEmail) {
                        const summary = await this.getIndividualShiftSummary(companyId, year, month, lastShift);
                        emailService.sendShiftAlert(
                            companyConfig.adminEmail,
                            employeeName,
                            "FORCE_OUT",
                            lastShift.end,
                            lastShift.location || "-",
                            companyConfig.businessName || companyId,
                            `המשמרת נסגרה אוטומטית כי חרגה מהמגבלה של ${this.formatHHMM(maxHours)} שעות.`,
                            companyConfig.logoUrl,
                            summary
                        ).catch(e => console.error(`[Lazy-Checkout Email FAIL] ${e.message}`));
                    }
                    return true; // Applied
                }
            }
        }
        return false;
    }

    async getIndividualShiftSummary(companyId, year, month, shift) {
        if (!shift || !shift.start || !shift.end) return null;

        try {
            const companyConfig = await this.getCompanyConfig(companyId);
            const holidayDates = await this.getHolidayDatesForMonth(companyId, year, month);
            const salaryConfig = companyConfig.settings?.salary || {};

            const workWeekType = config.settings?.constraints?.[employeeName]?.workWeekType || '5day';
            const result = WageCalculator.calculateBreakdown([shift], salaryConfig, holidayDates, workWeekType);

            return {
                duration: this.formatHHMM(result.totalHours),
                weightedHours: result.weightedTotal,
                breakdown: result.breakdown
            };
        } catch (e) {
            console.error(`[DataManager] Failed to calculate shift summary:`, e.message);
            return null;
        }
    }

    async getEmployees(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const config = CACHE.companies[companyId].config;

        // If config has employees, return them
        if (config.employees && config.employees.length > 0) {
            return config.employees.sort();
        }

        return []; // No employees added yet
    }

    async logShift(companyId, employeeName, action, timestamp, location, note, deviceId) {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;

        // 1. Employee Verification & Device ID Locking
        const companyConfig = await this.getCompanyConfig(companyId);
        const employees = companyConfig.employees || [];
        
        // Ensure employee is on the manager's list
        if (!employees.includes(employeeName)) {
            return {
                success: false,
                error: "AUTH_NAME_NOT_FOUND",
                message: "עובד לא נמצא ברשימת המנהל. פנה למנהל להוספה."
            };
        }

        if (companyConfig.settings?.constraints) {
            const constraints = companyConfig.settings.constraints;
            const empConstraint = constraints[employeeName];

            if (empConstraint) {
                // If device is already verified, check for mismatch
                if (empConstraint.deviceIdVerified && empConstraint.deviceId) {
                    if (deviceId && empConstraint.deviceId !== deviceId) {
                        return {
                            success: false,
                            error: "AUTH_DEVICE_MISMATCH",
                            message: "המכשיר אינו מאומת. לא ניתן להחתים עבור עובד אחר."
                        };
                    }
                }
                // If not verified and we have a device ID, lock it now
                else if (deviceId) {
                    empConstraint.deviceId = deviceId;
                    empConstraint.deviceIdVerified = true;
                    await this.updateCompanyConfig(companyId, companyConfig);
                    console.log(`[DeviceLock] Locked ${employeeName} to device ${deviceId}`);
                }
            } else {
                // Case where employee is in 'employees' list but missing from 'constraints'
                // This shouldn't happen with the new addEmployee, but handles legacy or edge cases
                if (!companyConfig.settings.constraints) companyConfig.settings.constraints = {};
                companyConfig.settings.constraints[employeeName] = {
                    deviceId: deviceId || "",
                    deviceIdVerified: !!deviceId
                };
                await this.updateCompanyConfig(companyId, companyConfig);
                if (deviceId) {
                    console.log(`[DeviceLock] Locked ${employeeName} to device ${deviceId} (New constraint)`);
                }
            }
        }

        const shifts = await this.getShifts(companyId, year, month);
        if (!shifts[employeeName]) shifts[employeeName] = [];
        let currentShift = null;
        if (action === "IN") {
            // --- TIME CONSTRAINTS CHECK (minStart / maxStart) ---
            if (companyConfig.settings?.constraints?.[employeeName]) {
                const c = companyConfig.settings.constraints[employeeName];
                const nowIL = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' });
                
                // minStart check
                if (c.minStart && nowIL < c.minStart) {
                    return {
                        success: false,
                        type: "CONSTRAINT",
                        error: "כניסה מוקדמת מדי",
                        limit: `מותר רק החל מ-${c.minStart}`
                    };
                }
                
                // maxStart check
                if (c.maxStart && nowIL > c.maxStart) {
                    return {
                        success: false,
                        type: "CONSTRAINT",
                        error: "כניסה מאוחרת מדי",
                        limit: `ניתן להיכנס רק עד-${c.maxStart}`
                    };
                }
            }

            currentShift = { start: timestamp, end: null, location };
            shifts[employeeName].push(currentShift);
        } else if (action === "OUT") {
            currentShift = shifts[employeeName][shifts[employeeName].length - 1];
            if (currentShift && !currentShift.end) {
                currentShift.end = timestamp;
                if (note) currentShift.note = note;
            } else {
                currentShift = { start: null, end: timestamp, note: "Manual Out without In" };
                shifts[employeeName].push(currentShift);
            }
        }

        // --- Distance Calculation (Integrated) ---
        try {
            const userConstraint = companyConfig.settings?.constraints?.[employeeName] || {};
            const isHybrid = userConstraint.isHybrid === true;
            const maxDist = userConstraint.maxDistance ? parseFloat(userConstraint.maxDistance) : 0;

            if (isHybrid) {
                if (currentShift) currentShift.distance = "עבודה היברידית (בטווח המורשה)";
            } else if (location && typeof location === 'object' && location.lat && location.lng) {
                const distMeters = this.calculateDistanceToPolygon(location.lat, location.lng, companyConfig.polygon);
                let distanceStr = "";
                if (distMeters === 0) distanceStr = "בתוך המשרד";
                else if (maxDist > 0 && distMeters <= maxDist) distanceStr = `בטווח המורשה (${Math.round(distMeters)} מ' מהמשרד)`;
                else if (distMeters < 1000) distanceStr = `${Math.round(distMeters)} מטרים מהמשרד`;
                else distanceStr = `${(distMeters / 1000).toFixed(1)} ק"מ מהמשרד`;

                if (currentShift) currentShift.distance = distanceStr;
            }

            // --- EMAIL NOTIFICATION (If Enabled) ---
            const isEmailEnabled = userConstraint.enableEmailUpdate === true;
            if (isEmailEnabled && companyConfig.adminEmail) {
                let summary = null;
                if (action === 'OUT' && currentShift) {
                    summary = await this.getIndividualShiftSummary(companyId, year, month, currentShift);
                }

                emailService.sendShiftAlert(
                    companyConfig.adminEmail,
                    employeeName,
                    action,
                    timestamp,
                    currentShift?.distance || (typeof location === 'string' ? location : "-"),
                    companyConfig.businessName,
                    note || "",
                    companyConfig.logoUrl,
                    summary
                ).catch(e => console.error(`[Email Alert] Failed to send shift alert: ${e.message}`));
            }
        } catch (e) {
            console.error(`[Shift Logic] Distance/Email calculation error: ${e.message}`);
        }

        // Final Persistence (Single call)
        await this.saveShifts(companyId, year, month, shifts);
        return { success: true };
    }

    formatHHMM(decimalHours) {
        const h = Math.floor(decimalHours);
        const m = Math.round((decimalHours - h) * 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    // --- DASHBOARD ---
    async getDashboard(companyId, year = null, month = null) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const now = new Date();
        const targetYear = year || now.getFullYear();
        const targetMonth = month || (now.getMonth() + 1);

        // Ensure target month loaded
        const shifts = await this.getShifts(companyId, targetYear, targetMonth);
        const employees = await this.getEmployees(companyId);
        const bizConfig = await this.getCompanyConfig(companyId);

        const dashboard = [];

        for (const emp of employees) {
            const empShifts = shifts[emp] || [];
            const lastShift = empShifts[empShifts.length - 1];

            // Calculate daily total
            let dailyTotal = 0;
            const todayStr = now.toDateString();

            empShifts.forEach(s => {
                const sDate = new Date(parseInt(s.start) || s.start || parseInt(s.end) || s.end);
                if (sDate.toDateString() === todayStr) {
                    if (s.end && s.start) {
                        dailyTotal += (new Date(parseInt(s.end) || s.end) - new Date(parseInt(s.start) || s.start)) / 3600000;
                    } else if (s.start && !s.end) {
                        dailyTotal += (now - new Date(parseInt(s.start) || s.start)) / 3600000;
                    }
                }
            });

            // Calculate monthly summary
            const holidayDates = await this.getHolidayDatesForMonth(companyId, targetYear, targetMonth);

            // Fix: Include active (open) shifts in the monthly calculation by providing a temporary end time
            const shiftsForCalculation = empShifts.map(s => {
                if (s.start && !s.end) {
                    return { ...s, end: Date.now() };
                }
                return s;
            });

            const workWeekType = bizConfig.settings?.constraints?.[emp]?.workWeekType || '5day';
            const wageResult = require('./WageCalculator').calculateBreakdown(shiftsForCalculation, bizConfig.settings?.salary || {}, holidayDates, workWeekType);

            dashboard.push({
                name: emp,
                status: (lastShift && !lastShift.end) ? 'IN' : 'OUT',
                time: (lastShift && !lastShift.end) ? lastShift.start : (lastShift ? lastShift.end : null),
                duration: this.formatHHMM(dailyTotal),
                monthlyTotal: this.formatHHMM(wageResult.totalHours),
                weightedTotal: this.formatHHMM(wageResult.weightedTotal),
                monthlyBreakdown: wageResult.breakdown
            });
        }

        return dashboard;
    }

    async getAvailableHolidays(companyId) {
        try {
            const bizConfig = await this.getCompanyConfig(companyId);
            const details = bizConfig?.settings?.salary?.holidays?.details || [];
            return details;
        } catch (e) {
            console.error(`[DataManager] getAvailableHolidays error:`, e.message);
            return [];
        }
    }

    async getStorageStats() {
        const stats = {
            total: 0,
            items: [],
            ram: process.memoryUsage().rss,
            dataDir: this.dataDir
        };

        const getDirStats = async (dir, relativePrefix = "") => {
            try {
                const items = await fs.readdir(dir);
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    const stat = await fs.stat(fullPath);
                    const relativeName = path.join(relativePrefix, item).replace(/\\/g, '/');

                    if (stat.isDirectory()) {
                        await getDirStats(fullPath, relativeName);
                    } else {
                        stats.total += stat.size;
                        stats.items.push({
                            name: relativeName,
                            size: stat.size,
                            timestamp: stat.mtimeMs || Date.now()
                        });
                    }
                }
            } catch (e) {
                console.error(`[Storage-Stats] Error reading ${dir}:`, e.message);
            }
        };

        await getDirStats(this.dataDir).catch(() => {});
        
        // Sort items by name for consistent UI
        stats.items.sort((a, b) => a.name.localeCompare(b.name));
        
        return stats;
    }


    async refreshHolidays(companyId) {
        // Disabled: relying on local config instead of GAS lookup
        return [];
    }

    async getHolidayDatesForMonth(companyId, year, month, employeeName = null) {
        const bizConfig = await this.getCompanyConfig(companyId);
        const details = bizConfig.settings?.salary?.holidays?.details || [];
        if (!Array.isArray(details)) return [];

        let eligibleNames = null;
        if (employeeName && bizConfig.settings?.constraints?.[employeeName]) {
            eligibleNames = bizConfig.settings.constraints[employeeName].qualifyingHolidays;
        }

        // If no employee specific settings, fallback to global (legacy support)
        if (!eligibleNames) {
            eligibleNames = bizConfig.settings?.salary?.holidays?.eligible;
        }

        // Collect all dates from all relevant holidays that fall in this month/year
        const holidayDates = [];
        details.forEach(h => {
            // Filter by name if eligibleNames is defined
            if (eligibleNames && !eligibleNames.includes(h.name)) return;

            if (Array.isArray(h.allDates)) {
                h.allDates.forEach(dStr => {
                    const [y, m, d] = dStr.split('-').map(Number);
                    if (y === year && m === month) {
                        holidayDates.push(dStr);
                    }
                });
            } else if (h.date) {
                const [y, m, d] = h.date.split('-').map(Number);
                if (y === year && m === month) {
                    holidayDates.push(h.date);
                }
            }
        });

        return [...new Set(holidayDates)].sort(); // Returns array of "yyyy-MM-dd"
    }

    // --- HISTORY META ---
    async getHistoryYears(companyId) {
        // Use Cached Metadata first (Instant)
        if (CACHE.companies[companyId] && CACHE.companies[companyId].metadata) {
            const keys = Object.keys(CACHE.companies[companyId].metadata.years || {});
            if (keys.length > 0) {
                return keys.map(y => parseInt(y)).sort((a, b) => b - a);
            }
        }

        // --- Fallback legacy scan (only if metadata missing) ---
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        const years = new Set();
        let bizConfig = await this.getCompanyConfig(companyId);

        try {
            const files = await fs.readdir(companyDir);
            for (const file of files) {
                if (file === 'config.json') continue;
                const stat = await fs.stat(path.join(companyDir, file));
                if (stat.isDirectory()) years.add(parseInt(file));
            }
        } catch (e) { }

        // Trigger a background refresh of the metadata
        this.refreshMetadata(companyId).catch(console.error);

        return Array.from(years).sort((a, b) => b - a);
    }

    async getHistoryMonths(companyId, year) {
        // Use Cached Metadata first
        if (CACHE.companies[companyId] && CACHE.companies[companyId].metadata) {
            const months = CACHE.companies[companyId].metadata.years[year.toString()];
            if (months) return months;
        }

        const yearDir = path.join(this.dataDir, 'companies', companyId, year.toString());
        const months = new Set();
        try {
            const files = await fs.readdir(yearDir);
            for (const file of files) {
                let parsedOpts = NaN;
                if (file.endsWith('.json')) parsedOpts = parseInt(file.replace('.json', ''));
                else if (file.startsWith('json.')) parsedOpts = parseInt(file.split('.')[1]);
                if (!isNaN(parsedOpts)) months.add(parsedOpts);
            }
        } catch (e) { }

        return Array.from(months).sort((a, b) => b - a);
    }

    async refreshMetadata(companyId) {
        const bizConfig = await this.getCompanyConfig(companyId);
        const gasUrl = bizConfig.gasUrl || config.GAS_COLD_STORAGE_URL;
        if (!gasUrl) return;

        try {
            console.log(`[Metadata] Refreshing metadata from GAS for ${companyId}`);
            const response = await axios.get(`${gasUrl}?action=getMetadataSummary&companyId=${companyId}&password=${bizConfig.password || ''}`, { timeout: 15000 });

            if (response.data && response.data.success && response.data.metadata) {
                const remoteMetadata = response.data.metadata;

                // 1. Scan Local Data
                const localMetadata = { years: {} };
                const companyDir = path.join(this.dataDir, 'companies', companyId);
                const folders = await fs.readdir(companyDir).catch(() => []);
                for (const f of folders) {
                    if (!isNaN(parseInt(f))) {
                        const yearPath = path.join(companyDir, f);
                        const mFiles = await fs.readdir(yearPath).catch(() => []);
                        const mSet = new Set();
                        mFiles.forEach(mf => {
                            let m = NaN;
                            if (mf.endsWith('.json')) m = parseInt(mf.replace('.json', ''));
                            else if (mf.startsWith('json.')) m = parseInt(mf.split('.')[1]);
                            if (!isNaN(m)) mSet.add(m);
                        });
                        if (mSet.size > 0) {
                            localMetadata.years[f] = Array.from(mSet).sort((a, b) => b - a);
                        }
                    }
                }

                // 2. Merge: Remote (GAS Archive) + Local (Hot/Pending)
                for (const y in remoteMetadata.years) {
                    const combined = new Set([...(localMetadata.years[y] || []), ...remoteMetadata.years[y]]);
                    localMetadata.years[y] = Array.from(combined).sort((a, b) => b - a);
                }

                // 3. Update RAM Cache
                if (!CACHE.companies[companyId]) await this.loadCompany(companyId);
                CACHE.companies[companyId].metadata = localMetadata;

                // 4. Update config.json on disk
                const configPath = path.join(companyDir, 'config.json');
                const currentConfig = CACHE.companies[companyId].config;
                currentConfig.historyMetadata = localMetadata;

                await fs.writeFile(configPath, JSON.stringify(currentConfig, null, 2));

                // 5. Sync back to GAS as a backup (Optional but good practice)
                syncManager.enqueue('CONFIG', currentConfig, { companyId, gasUrl, password: currentConfig.password });

                console.log(`[Metadata] Successfully synced ${Object.keys(localMetadata.years).length} years for ${companyId}`);
                return localMetadata;
            }
        } catch (err) {
            console.error(`[Metadata] Refresh failed for ${companyId}: ${err.message}`);
        }
        return null;
    }

    /**
     * Proactively ensures all businesses have history metadata populated.
     * If missing, fetches from GAS.
     */
    async ensureAllBusinessesHaveMetadata() {
        console.log(`[Metadata-Sync] Scanning all businesses for history filters...`);
        let syncCount = 0;

        for (const client of CACHE.clients) {
            const companyId = client.id;
            try {
                if (!CACHE.companies[companyId]) await this.loadCompany(companyId);
                const meta = CACHE.companies[companyId].metadata;

                const hasYears = meta && meta.years && Object.keys(meta.years).length > 0;

                if (!hasYears) {
                    console.log(`[Metadata-Sync] ${companyId} is missing history filters. Fetching from GAS...`);
                    await this.refreshMetadata(companyId);
                    syncCount++;
                }
            } catch (err) {
                console.error(`[Metadata-Sync] Failed for ${companyId}:`, err.message);
            }
        }
        console.log(`[Metadata-Sync] Finished. Triggered sync for ${syncCount} businesses.`);
    }

    // --- ADMIN ACTIONS ---

    async adminSaveShift(companyId, { year, month, name, originalStart, newStart, newEnd }) {
        const shifts = await this.getShifts(companyId, parseInt(year), parseInt(month));
        if (!shifts[name]) shifts[name] = []; // Initialize if missing

        // Make sure to parse numeric strings (Epoch) correctly, as new Date("17727...") becomes Invalid Date.
        const safeGetTime = (t) => {
            if (!t) return null;
            if (typeof t === 'number') return new Date(t).getTime();
            if (typeof t === 'string' && !isNaN(t)) return new Date(parseInt(t)).getTime();
            return new Date(t).getTime();
        };

        const targetStart = safeGetTime(originalStart);
        const shiftIndex = shifts[name].findIndex(s => safeGetTime(s.start) === targetStart);
        if (shiftIndex !== -1) {
            shifts[name][shiftIndex].start = newStart;
            shifts[name][shiftIndex].end = newEnd;
            await this.saveShifts(companyId, parseInt(year), parseInt(month), shifts);
        } else {
            // Maybe creating new shift?
            // If originalStart is null or empty, it's a new shift.
            if (!originalStart) {
                shifts[name].push({ start: newStart, end: newEnd, location: 'Admin Add' });
                await this.saveShifts(companyId, parseInt(year), parseInt(month), shifts);
            }
        }
    }

    async getCompanyHistory(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const companyDir = path.join(this.dataDir, 'companies', companyId);
        let allShifts = [];
        let config = null;

        try {
            config = await this.getCompanyConfig(companyId);
            const items = await fs.readdir(companyDir, { withFileTypes: true });

            for (const item of items) {
                // If the item is a directory, it should be a year directory (e.g., '2024')
                if (item.isDirectory() && !isNaN(parseInt(item.name))) {
                    const yearDir = path.join(companyDir, item.name);
                    const monthFiles = await fs.readdir(yearDir);

                    for (const monthFile of monthFiles) {
                        if (monthFile.endsWith('.json') || monthFile.startsWith('json.')) {
                            const filePath = path.join(yearDir, monthFile);

                            try {
                                const fileData = await fs.readFile(filePath, 'utf8');
                                const shifts = JSON.parse(fileData);

                                // Flatten shifts object into an array
                                for (const user in shifts) {
                                    if (Array.isArray(shifts[user])) {
                                        allShifts = allShifts.concat(shifts[user]);
                                    }
                                }
                            } catch (e) {
                                console.error(`[DataManager] Error parsing history file ${filePath}:`, e.message);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`[DataManager] Error accessing company directory ${companyDir}:`, e.message);
        }

        // --- Merge with GAS Archive if available ---
        if (config && config.gasUrl) {
            try {
                // Determine which years/months we ALREADY have locally so we don't duplicate
                const localYears = await this.getHistoryYears(companyId);
                const localMonths = {}; // { '2024': [1,2,3], ... }
                for (const y of localYears) {
                    localMonths[y] = await this.getHistoryMonths(companyId, y);
                }

                const response = await axios.get(`${config.gasUrl}?action=getFullArchive&companyId=${companyId}&password=${config.password}`);
                if (response.data && response.data.success && response.data.data) {

                    const archiveShifts = Array.isArray(response.data.data) ? response.data.data : [];

                    // Filter out shifts that belong to months we already have locally to prevent duplicates
                    const filteredArchive = archiveShifts.filter(s => {
                        const sd = new Date(parseInt(s.start) || s.start);
                        if (isNaN(sd)) return false;
                        const sy = sd.getFullYear();
                        const sm = sd.getMonth() + 1;

                        // If we have this month locally, skip the archived version
                        if (localMonths[sy] && localMonths[sy].includes(sm)) return false;
                        return true;
                    });

                    allShifts = allShifts.concat(filteredArchive);
                }
            } catch (err) {
                console.error(`[GAS] Failed to fetch full archive payload for ${companyId}: ${err.message}`);
            }
        }

        // Sort all shifts by date descending
        return allShifts.sort((a, b) => new Date(b.date) - new Date(a.date));
    }

    async archiveAndCleanup(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);
        const config = CACHE.companies[companyId].config;

        const companyDir = path.join(this.dataDir, 'companies', companyId);
        let archivedCount = 0;

        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;

        try {
            const items = await fs.readdir(companyDir, { withFileTypes: true });

            for (const item of items) {
                if (item.isDirectory() && !isNaN(parseInt(item.name))) {
                    const yearDir = path.join(companyDir, item.name);
                    const year = parseInt(item.name);
                    const monthFiles = await fs.readdir(yearDir);

                    for (const monthFile of monthFiles) {
                        if (!monthFile.endsWith('.json') && !monthFile.startsWith('json.')) continue;

                        let monthStr = monthFile.replace('.json', '').replace('json.', '');
                        const month = parseInt(monthStr);

                        // Keep current month and previous month. Archive everything older.
                        const isCurrentMonth = (year === currentYear && month === currentMonth);
                        let prevMonth = currentMonth - 1;
                        let prevYear = currentYear;
                        if (prevMonth === 0) { prevMonth = 12; prevYear = currentYear - 1; }
                        const isPreviousMonth = (year === prevYear && month === prevMonth);

                        if (!isCurrentMonth && !isPreviousMonth) {
                            const filePath = path.join(yearDir, monthFile);
                            const fileData = await fs.readFile(filePath, 'utf8');

                            try {
                                if (config && config.gasUrl) {
                                    const response = await axios.post(config.gasUrl, {
                                        action: 'archiveMonth',
                                        companyId: companyId,
                                        year: year,
                                        month: month,
                                        data: fileData,
                                        password: config.password
                                    }).catch(e => { console.error(`[Archive] GAS push failed: ${e.message}`); return { data: null }; });

                                    if (response.data && response.data.success) {
                                        await fs.unlink(filePath);
                                        archivedCount++;
                                        console.log(`[Archive] Successfully archived and deleted ${year}/${month} for ${companyId}`);
                                    }
                                } else {
                                    // No GAS URL, just purge to save Render limits
                                    await fs.unlink(filePath);
                                    archivedCount++;
                                    console.log(`[Archive] Purging local DB for ${year}/${month} (No GAS link available)`);
                                }
                            } catch (err) {
                                console.error(`[Archive] Failed to archive ${year}/${month} for ${companyId}:`, err.message);
                            }
                        }
                    }
                }
            }

            // Done
            return { success: true, archived: archivedCount };
        } catch (e) {
            console.error(`[Archive] Error processing company directory ${companyDir}:`, e.message);
            return { success: false, error: e.message };
        }
    }

    async adminDeleteShift(companyId, { year, month, name, start }) {
        const shifts = await this.getShifts(companyId, parseInt(year), parseInt(month));
        if (!shifts[name]) return;

        const safeGetTime = (t) => {
            if (!t) return null;
            if (typeof t === 'number') return new Date(t).getTime();
            if (typeof t === 'string' && !isNaN(t)) return new Date(parseInt(t)).getTime();
            return new Date(t).getTime();
        };

        // Filter out by start time safely
        const targetTime = safeGetTime(start);
        shifts[name] = shifts[name].filter(s => safeGetTime(s.start) !== targetTime);
        await this.saveShifts(companyId, parseInt(year), parseInt(month), shifts);
    }

    async adminForceAction(companyId, { name, forceType }) {
        // forceType: 'checkIn' | 'checkOut'
        const label = forceType === 'checkIn' ? 'כניסה כפויה על ידי מנהל' : 'יציאה כפויה על ידי מנהל';
        await this.logShift(companyId, name, forceType === 'checkIn' ? 'IN' : 'OUT', Date.now(), label, 'פעולה יזומה על ידי מנהל');
    }

    // --- EMPLOYEE MANAGEMENT ---

    async addEmployee(companyId, name) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);
        const config = CACHE.companies[companyId].config;

        if (!config.employees) config.employees = [];

        if (!config.employees.includes(name)) {
            config.employees.push(name);
            
            // Initialize constraints for the new employee to allow controlled Device ID locking
            if (!config.settings) config.settings = {};
            if (!config.settings.constraints) config.settings.constraints = {};
            
            if (!config.settings.constraints[name]) {
                config.settings.constraints[name] = {
                    deviceId: "",
                    deviceIdVerified: false
                };
                console.log(`[DataManager] Initialized constraints for new employee: ${name}`);
            }

            await this.updateCompanyConfig(companyId, config);
        }

        // Also add to current month to ensure UI updates
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const shifts = await this.getShifts(companyId, year, month);

        if (!shifts[name]) {
            shifts[name] = [];
            await this.saveShifts(companyId, year, month, shifts);
        }
        return { success: true };
    }

    async deleteEmployee(companyId, name) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);
        const config = CACHE.companies[companyId].config;

        const client = await this.getClientById(companyId);
        if (!client) throw new Error("Client not found for deletion validation.");

        // Determine the billing cycle start date (subscription renewal date)
        const subscriptionDate = client.subscriptionDate ? new Date(client.subscriptionDate) : (client.joinedAt ? new Date(client.joinedAt) : new Date());
        
        // Load current and previous month shifts to check for activity since renewal
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const currentShifts = await this.getShifts(companyId, currentYear, currentMonth);
        
        const userShifts = currentShifts[name] || [];
        
        // Check if there are any shifts on or after the subscriptionDate in the current month
        for (const shift of userShifts) {
            const shiftDate = shift.start ? new Date(shift.start) : new Date(shift.date); // Fallback to date if start missing
            if (shiftDate >= subscriptionDate) {
                throw new Error("לא ניתן למחוק את העובד משום שהחתים משמרת במחזור החיוב הנוכחי. תוכל למחוק אותו רק לאחר תאריך חידוש התוקף, בתנאי שלא יחתים משמרות נוספות.");
            }
        }

        // Remove from employees list
        if (config.employees) {
            config.employees = config.employees.filter(e => e !== name);
        }

        // Remove from constraints
        if (config.settings?.constraints && config.settings.constraints[name]) {
            delete config.settings.constraints[name];
        }

        // Remove from dashboard list in config
        if (config.settings?.dashboard) {
            config.settings.dashboard = (config.settings.dashboard || []).filter(e => e && e.name !== name);
        }

        await this.updateCompanyConfig(companyId, config);

        // DO NOT delete from shifts history (periods loop removed) to ensure accurate billing for past work.
        
        return { success: true };
    }

    // --- HOT STORAGE MANAGEMENT ---

    isHotMonth(year, month) {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;

        // Current month
        if (year === currentYear && month === currentMonth) return true;

        // Last month (handle year boundary)
        const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
        const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;

        if (year === lastMonthYear && month === lastMonth) return true;

        return false;
    }

    async cleanupOldMonths() {
        console.log('[Cleanup] Starting monthly cleanup...');
        const companiesDir = path.join(this.dataDir, 'companies');

        try {
            const companies = await fs.readdir(companiesDir);

            for (const companyId of companies) {
                const companyDir = path.join(companiesDir, companyId);
                const years = await fs.readdir(companyDir);

                for (const yearStr of years) {
                    if (yearStr === 'config.json') continue;
                    const yearDir = path.join(companyDir, yearStr);
                    const months = await fs.readdir(yearDir);

                    for (const monthFile of months) {
                        const month = parseInt(monthFile.replace('.json', ''));
                        const year = parseInt(yearStr);

                        if (!this.isHotMonth(year, month)) {
                            const filePath = path.join(yearDir, monthFile);
                            await fs.unlink(filePath);
                            console.log(`[Cleanup] Deleted: ${companyId}/${year}/${month}.json`);

                            // Remove from RAM cache
                            const cacheKey = `${year}-${month}`;
                            if (CACHE.companies[companyId]?.shifts[cacheKey]) {
                                delete CACHE.companies[companyId].shifts[cacheKey];
                            }
                        }
                    }
                }
            }

            console.log('[Cleanup] Cleanup completed successfully');
        } catch (e) {
            console.error('[Cleanup] Error during cleanup:', e);
        }
    }

    async getBackupData() {
        console.log('[Backup] Generating full generic backup from disk...');
        const backup = {
            timestamp: new Date().toISOString(),
            lastWriteTime: await this.getLastWriteTime(), // Sync Indicator
            files: [] // GENERIC ARRAY
        };

        const readDirRec = async (dir, relativePath = '') => {
            try {
                const items = await fs.readdir(dir);
                for (const item of items) {
                    const fullPath = path.join(dir, item);
                    // Use forward slash for paths regardless of OS so GAS handles it consistently
                    const relPath = relativePath ? `${relativePath}/${item}` : item;
                    const stat = await fs.stat(fullPath);
                    if (stat.isDirectory()) {
                        await readDirRec(fullPath, relPath);
                    } else if (item.endsWith('.json')) {
                        try {
                            const content = await fs.readFile(fullPath, 'utf8');
                            backup.files.push({
                                path: relPath,
                                content: JSON.parse(content)
                            });
                        } catch (e) {
                            console.error(`[Backup] Error reading/parsing ${relPath}:`, e);
                        }
                    }
                }
            } catch (e) {
                console.error(`[Backup] Error reading dir ${dir}:`, e);
            }
        };

        await readDirRec(this.dataDir);
        console.log(`[Backup] Collected ${backup.files.length} files for backup.`);

        return backup;
    }

    async fetchColdData(companyId, year, month) {
        // Fetch historical data from GAS
        const cacheKey = `${year}-${month}`;
        const companyCache = CACHE.historicalData[companyId] || {};

        // Check cache first (1 hour TTL)
        if (companyCache[cacheKey]) {
            const cached = companyCache[cacheKey];
            const age = Date.now() - cached.timestamp;
            if (age < 3600000) { // 1 hour
                console.log(`[Cold Data] Cache hit for ${companyId}/${year}/${month}`);
                return cached.data;
            }
        }

        // Fetch from GAS
        try {
            const configObj = await this.getCompanyConfig(companyId);
            const gasUrl = configObj ? configObj.gasUrl : null;
            if (!gasUrl) {
                console.warn(`[Cold Data] gasUrl not configured for ${companyId}`);
                return {};
            }

            console.log(`[Cold Data] Fetching from GAS: ${companyId}/${year}/${month}`);
            const response = await axios.get(`${gasUrl}?action=getArchivedMonth&companyId=${companyId}&year=${year}&month=${month}&password=${configObj.password}`, {
                timeout: 10000
            });

            if (!response.data || !response.data.success || !response.data.data) {
                console.warn(`[Cold Data] GAS returned error or no data for ${companyId}/${month}/${year}`);
                return {};
            }

            const data = typeof response.data.data === 'string' ? JSON.parse(response.data.data) : response.data.data;

            // Cache it
            if (!CACHE.historicalData[companyId]) {
                CACHE.historicalData[companyId] = {};
            }
            CACHE.historicalData[companyId][cacheKey] = {
                data,
                timestamp: Date.now()
            };

            return data;
        } catch (e) {
            console.error(`[Cold Data] Error fetching from GAS:`, e.message);
            return {};
        }
    }

    async getShiftsHybrid(companyId, year, month) {
        // Smart routing: hot vs cold
        if (this.isHotMonth(year, month)) {
            return await this.getShifts(companyId, year, month);
        } else {
            return await this.fetchColdData(companyId, year, month);
        }
    }
    // --- DISASTER RECOVERY ---

    async smartRestoreFromGAS(localTime) {
        try {
            const gasUrl = config.GAS_COLD_STORAGE_URL;
            if (!gasUrl) {
                console.error('[Restore] GAS URL not configured.');
                return false;
            }

            console.log(`[Restore] URL: ${gasUrl} | Requesting path=restore`);
            const response = await axios.get(`${gasUrl}?path=restore`, { timeout: 45000 });

            if (!response.data || !response.data.success) {
                console.error(`[Restore] GAS error: ${response.data?.error || 'Unknown error'}`);
                return false;
            }

            const backup = response.data.data;
            if (!backup) {
                console.error('[Restore] No data returned in GAS response');
                return false;
            }

            const remoteTime = (backup.metadata && backup.metadata.lastWriteTime) ? backup.metadata.lastWriteTime : (backup.lastWriteTime || 0);

            console.log(`[Restore] Remote Timestamp: ${new Date(remoteTime).toISOString()} | Local: ${new Date(localTime).toISOString()}`);

            // DECISION LOGIC:
            // 1. If we have NO local data (localTime = 0) OR forced sync, Restore.
            // 2. If Remote is NEWER than Local (remoteTime > localTime), Restore.
            // 3. Otherwise, stick with Local.

            if (localTime > 0 && localTime >= remoteTime) {
                console.log('[Restore] Local data is up-to-date. Skipping restore.');
                return true;
            }

            console.log(`[Restore] Starting Restoration (Remote ${remoteTime} > Local ${localTime})...`);

            // Generic Restore
            if (backup.files && Array.isArray(backup.files)) {
                // DATA PROTECTION: Do not restore if local has data but backup is empty
                const clientsFile = backup.files.find(f => f.path === 'clients.json');
                const hasLocalData = CACHE.clients && CACHE.clients.length > 0;
                if (hasLocalData && clientsFile && Array.isArray(clientsFile.content) && clientsFile.content.length === 0) {
                    console.warn("[Restore] Skipping restore: Backup has empty clients.json but local has data.");
                    return false;
                }
                
                console.log(`[Restore] Found ${backup.files.length} files to restore.`);

                // Sort files to ensure clients.json or config files are written first if needed, 
                // though usually order doesn't matter for disk but does for cache reload logic later.
                for (const file of backup.files) {
                    try {
                        const fullPath = path.join(this.dataDir, file.path);
                        const dirPath = path.dirname(fullPath);
                        await fs.mkdir(dirPath, { recursive: true });

                        // If content is already an object, stringify it. If it's a string, write directly.
                        const contentToWrite = typeof file.content === 'object' ? JSON.stringify(file.content, null, 2) : file.content;
                        await fs.writeFile(fullPath, contentToWrite);
                        // console.log(`[Restore] Restored: ${file.path}`);
                    } catch (e) {
                        console.error(`[Restore] Failed to write file ${file.path}:`, e.message);
                    }
                }

                // IMPORTANT: Reload Cache immediately after disk write
                try {
                    console.log("[Restore] Reloading clients into memory cache...");
                    const clientsData = await fs.readFile(this.clientsFile, 'utf8');
                    CACHE.clients = JSON.parse(clientsData);
                    console.log(`[Restore] Cache reloaded: ${CACHE.clients.length} clients.`);
                } catch (e) {
                    console.error("[Restore] Critical: Could not reload clients.json into cache after restoration:", e.message);
                }

                // Clear companies cache and reload them
                CACHE.companies = {};
                for (const client of CACHE.clients) {
                    try {
                        await this.loadCompany(client.id);
                    } catch (e) {
                        console.error(`[Restore] Failed to load company ${client.id}:`, e.message);
                    }
                }
            } else {
                console.warn("[Restore] No files found in backup data package.");
            }

            // Sync Timestamp to match Remote
            if (remoteTime > 0) {
                await fs.writeFile(this.metadataFile, JSON.stringify({ lastWriteTime: remoteTime }));
            }

            console.log('[Restore] Restoration Complete!');
            return true;

        } catch (e) {
            console.error(`[Restore] Critical Failure: ${e.message}`);
            if (e.response) console.error(`[Restore] Server Response:`, e.response.data);
            return false;
        }
    }

    // --- EXPORT ---

    async getUserFullHistory(companyId, employeeName) {
        const allShifts = [];
        const seenKeys = new Set();

        const addShift = (s) => {
            if (!s || !s.start) return;
            const key = String(s.start);
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                allShifts.push(s);
            }
        };

        // 1. Fetch Cold (Archived) Data from GAS
        const gasUrl = config.GAS_COLD_STORAGE_URL;
        if (gasUrl) {
            try {
                console.log(`[History] Fetching full archive from GAS for ${companyId}/${employeeName}`);
                // Ensure name is encoded for Hebrew characters
                const response = await axios.get(`${gasUrl}?action=getFullUserHistory&companyId=${companyId}&name=${encodeURIComponent(employeeName)}`, {
                    timeout: 25000
                });
                if (response.data && response.data.success && Array.isArray(response.data.shifts)) {
                    console.log(`[History] GAS returned ${response.data.shifts.length} cold shifts`);
                    response.data.shifts.forEach(addShift);
                }
            } catch (e) {
                console.error(`[History] GAS fetch failed:`, e.message);
            }
        }

        // 2. Merge with Hot (Local) Data from Render disk
        try {
            const companyDir = path.join(this.dataDir, 'companies', companyId);
            const items = await fs.readdir(companyDir, { withFileTypes: true }).catch(() => []);
            for (const item of items) {
                if (!item.isDirectory() || isNaN(parseInt(item.name))) continue;

                const year = item.name;
                const yearDir = path.join(companyDir, year);
                const monthFiles = await fs.readdir(yearDir).catch(() => []);

                for (const monthFile of monthFiles) {
                    let monthNum = NaN;
                    if (monthFile.endsWith('.json')) monthNum = parseInt(monthFile.replace('.json', ''));
                    else if (monthFile.startsWith('json.')) monthNum = parseInt(monthFile.split('.')[1]);
                    if (isNaN(monthNum)) continue;

                    const shifts = await this.getShifts(companyId, parseInt(year), monthNum).catch(() => ({}));
                    if (shifts[employeeName]) {
                        shifts[employeeName].forEach(addShift);
                    }
                }
            }
        } catch (e) {
            console.error(`[History] Local disk read failed:`, e.message);
        }

        return allShifts.sort((a, b) => parseInt(b.start) - parseInt(a.start));
    }

    async getFullHistoryForExport(companyId) {
        // Returns all shift data as a combined object keyed by employee name
        const combined = {}; // { employeeName: [shifts...] }
        const seenByEmployee = {};

        const addShift = (employeeName, shift) => {
            if (!combined[employeeName]) { combined[employeeName] = []; seenByEmployee[employeeName] = new Set(); }
            const key = String(shift.start);
            if (!seenByEmployee[employeeName].has(key)) {
                seenByEmployee[employeeName].add(key);
                combined[employeeName].push(shift);
            }
        };

        // 1. Get Cold Data from GAS
        const gasUrl = config.GAS_COLD_STORAGE_URL;
        if (gasUrl) {
            try {
                const r = await axios.get(`${gasUrl}?action=getFullArchive&companyId=${companyId}`, { timeout: 30000 });
                if (r.data && r.data.success && Array.isArray(r.data.data)) {
                    // GAS getFullArchive returns a flat array -- but we need per-employee
                    // Fetch by months instead for structured data
                }
                // Better: fetch years and iterate months
                const yearsRes = await axios.get(`${gasUrl}?action=getYears&companyId=${companyId}`, { timeout: 10000 });
                if (yearsRes.data && yearsRes.data.success && Array.isArray(yearsRes.data.years)) {
                    for (const year of yearsRes.data.years) {
                        const monthsRes = await axios.get(`${gasUrl}?action=getMonths&companyId=${companyId}&year=${year}`, { timeout: 10000 });
                        if (monthsRes.data && monthsRes.data.success && Array.isArray(monthsRes.data.months)) {
                            for (const month of monthsRes.data.months) {
                                const mRes = await axios.get(`${gasUrl}?action=getArchivedMonth&companyId=${companyId}&year=${year}&month=${month}`, { timeout: 15000 });
                                if (mRes.data && mRes.data.success && mRes.data.data) {
                                    const parsed = typeof mRes.data.data === 'string' ? JSON.parse(mRes.data.data) : mRes.data.data;
                                    for (const [emp, shifts] of Object.entries(parsed)) {
                                        if (Array.isArray(shifts)) shifts.forEach(s => addShift(emp, s));
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[FullExport] GAS fetch failed:', e.message);
            }
        }

        // 2. Merge Hot (Local) Data
        try {
            const companyDir = path.join(this.dataDir, 'companies', companyId);
            const years = await fs.readdir(companyDir).catch(() => []);
            for (const year of years) {
                if (year === 'config.json') continue;
                const yearDir = path.join(companyDir, year);
                const stat = await fs.stat(yearDir).catch(() => null);
                if (!stat || !stat.isDirectory()) continue;
                const months = await fs.readdir(yearDir).catch(() => []);
                for (const monthFile of months) {
                    let monthNum = NaN;
                    if (monthFile.endsWith('.json')) monthNum = parseInt(monthFile.replace('.json', ''));
                    else if (monthFile.startsWith('json.')) monthNum = parseInt(monthFile.split('.')[1]);
                    if (isNaN(monthNum)) continue;
                    const shifts = await this.getShifts(companyId, parseInt(year), monthNum).catch(() => ({}));
                    for (const [emp, empShifts] of Object.entries(shifts)) {
                        if (Array.isArray(empShifts)) empShifts.forEach(s => addShift(emp, s));
                    }
                }
            }
        } catch (e) {
            console.error('[FullExport] Local disk read failed:', e.message);
        }

        return combined;
    }

    async createBusiness(data) {
        // data: { businessName, email, phone, password, ... }
        // Simple 4 digit ID loop
        let newId;
        do {
            newId = Math.floor(1000 + Math.random() * 9000).toString();
        } while (CACHE.companies[newId] || CACHE.clients.find(c => c.id === newId));

        // Clean data
        const safePassword = data.password ? data.password.toString() : '';

        // Subscription Expiry Logic: Align with next chargeDay/chargeTime
        const sysConfig = await this.getSystemConfig();
        // Target is always the 1st of the NEXT month at 04:00
        const trialExpiry = this.getNextBillingDate();

        let pMethodSafe = null;
        let invoiceDetails = null;
        if (data.paymentMethod) {
            const { invoiceDetails: invDet, ...rest } = data.paymentMethod;
            pMethodSafe = Object.keys(rest).length ? rest : null;
            invoiceDetails = invDet;
        }

        const client = {
            id: newId,
            businessName: data.businessName,
            email: data.email,
            phone: data.phone,
            password: safePassword,
            subscriptionExpiry: trialExpiry.toISOString(),
            subscriptionDate: new Date().toISOString(), // Initial registration date
            joinedAt: new Date().toISOString(),

            autoChargeEnabled: true, // Default to true as per requirement
            paymentMethod: pMethodSafe
        };

        CACHE.clients.push(client);
        await this.saveClients();

        // Prepare detailed default holidays
        const defaultHolidaysDetails = [];
        const eligibleDefaults = config.MAJOR_HOLIDAYS || [];

        // Attempt a one-time cold fetch to GAS to populate initial dates, don't wait if it fails
        try {
            const gasUrl = config.GAS_COLD_STORAGE_URL;
            if (gasUrl) {
                const response = await axios.get(`${gasUrl}?action=getHolidays&companyId=new&password=`, { timeout: 10000 }).catch(() => null);
                if (response?.data?.success && response.data.events) {
                    const events = response.data.events;
                    eligibleDefaults.forEach(hName => {
                       const translated = config.HOLIDAY_MAPPING?.[hName] || hName;
                       const allDates = Object.keys(events).filter(d => events[d].includes(hName) || events[d].includes(translated)).sort();
                       let hDate = null;
                       if (allDates.length > 0) {
                           const nowStr = new Date().toISOString().split('T')[0];
                           hDate = allDates.find(d => d >= nowStr) || allDates[allDates.length - 1];
                       }
                       defaultHolidaysDetails.push({ name: hName, date: hDate, allDates });
                    });
                }
            }
        } catch(e) { console.error("[DataManager] Initial holiday fetch failed:", e.message); }

        const companyConfig = {
            companyId: newId,
            businessName: data.businessName,
            settings: {
                salary: {
                    holidays: {
                        eligible: eligibleDefaults,
                        details: defaultHolidaysDetails.length > 0 ? defaultHolidaysDetails : eligibleDefaults.map(h => ({ name: h, date: null, allDates: [] }))
                    }
                }
            },
            polygon: data.polygon || [],
            adminEmail: data.email,
            logoUrl: data.logoUrl || null
        };

        if (invoiceDetails) {
            companyConfig.invoiceDetails = invoiceDetails;
        }

        await this.updateCompanyConfig(newId, companyConfig);

        // Send Welcome Email
        if (client.email) {
            emailService.sendWelcomeEmail(client.email, client.businessName, client.id, client.password)
                .catch(err => console.error(`[DataManager] Failed to send welcome email to ${client.id}:`, err.message));
        }

        return client;
    }

    async deleteBusiness(companyId) {
        // 1. Notify GAS Cold Storage to delete data there
        const gasUrl = config.GAS_COLD_STORAGE_URL;
        if (gasUrl) {
            try {
                console.log(`[DataManager] Notifying GAS to delete data for ${companyId}`);
                await axios.get(`${gasUrl}?action=deleteBusiness&companyId=${companyId}`, { timeout: 15000 });
            } catch (e) {
                console.error(`[DataManager] Failed to notify GAS for deletion of ${companyId}:`, e.message);
                // We continue local deletion even if GAS notification fails
            }
        }

        // 2. Remove from clients array
        const initialLen = CACHE.clients.length;
        CACHE.clients = CACHE.clients.filter(c => c.id !== companyId);

        if (CACHE.clients.length === initialLen) {
            throw new Error('Business not found');
        }
        await this.saveClients();

        // 3. Remove from active cache
        if (CACHE.companies[companyId]) {
            delete CACHE.companies[companyId];
        }
        if (CACHE.historicalData[companyId]) {
            delete CACHE.historicalData[companyId];
        }

        // 4. Delete from filesystem
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        try {
            await fs.rm(companyDir, { recursive: true, force: true });
        } catch (e) {
            console.error(`[DataManager] Error deleting directory for ${companyId}:`, e.message);
        }

        await this.updateLastWriteTime();
        return true;
    }

    async renewSubscription(companyId) {
        try {
            const client = await this.getClientById(companyId);
            if (!client) return { success: false, error: "Business not found" };

            const sysConfig = await this.getSystemConfig();

            // Calculate next expiry: 2nd of the next month (as seen in record-payment)
            // or according to chargeDay from sysConfig. 
            // התשלום הבא יתבצע באופן יחסי - ועלייך לעדכן את ה-SubscriptionDate לזמן הנוכחי
            // Let's set it to the 2nd of the next month.
            // Target is always the 1st of the NEXT month at 04:00
            const nextExpiry = this.getNextBillingDate();

            client.subscriptionExpiry = nextExpiry.toISOString();
            client.subscriptionDate = new Date().toISOString(); // Crucial for proration in next cycle
            client.billingFailed = false;

            // Record in payment history
            if (!client.paymentHistory) client.paymentHistory = [];
            client.paymentHistory.push({
                date: new Date().toLocaleDateString('he-IL'),
                fullDate: new Date().toISOString(),
                amount: 0,
                currency: 'ILS',
                period: 1,
                method: 'Manual Renewal',
                description: 'חידוש מנוי ידני (ללא חוב)',
                status: 'PAID',
                statusDisplayName: 'חודשי',
                reference: 'MANUAL-RENEW'
            });

            await this.saveClients();

            // Notify
            const recipients = [client.email, 'tempusgeo@gmail.com'];
            recipients.forEach(email => {
                emailService.sendPaymentSuccessNotification(email, {
                    businessName: client.businessName,
                    amount: 0,
                    activeEmployees: 0,
                    newExpiry: nextExpiry.toLocaleDateString('he-IL')
                }).catch(console.error);
            });

            return { success: true, newExpiry: nextExpiry.toLocaleDateString('he-IL') };
        } catch (e) {
            console.error('[DataManager] renewSubscription error:', e.message);
            return { success: false, error: e.message };
        }
    }

    // --- MAINTENANCE TASKS ---

    async performAutoCheckout() {
        const now = new Date();
        const results = { checked: 0, closed: 0, errors: [] };

        this.logMaintenance('CHECKOUT', `Starting recurring scan for ${CACHE.clients.length} businesses.`);

        for (const client of CACHE.clients) {
            try {
                results.checked++;
                const year = now.getFullYear();
                const month = now.getMonth() + 1;

                const companyConfig = await this.getCompanyConfig(client.id);
                const constraints = companyConfig?.settings?.constraints || {};

                const systemConfig = await this.getSystemConfig();
                const globalMaxHours = systemConfig.maxShiftHours || 12;

                const shiftsData = await this.getShifts(client.id, year, month);
                let changed = false;

                for (const [user, shifts] of Object.entries(shiftsData)) {
                    for (const shift of shifts) {
                        if (!shift.end && shift.start) {
                            const startTime = new Date(parseInt(shift.start) || shift.start);
                            const durationHours = (now.getTime() - startTime.getTime()) / 3600000;
                            const userConstraint = constraints[user] || {};

                            const hasCustomRule = !!userConstraint.maxDuration;
                            const maxHours = hasCustomRule ? parseFloat(userConstraint.maxDuration) : globalMaxHours;
                            const enableAutoOut = hasCustomRule ? (userConstraint.enableAutoOut === true) : true;
                            const enableAlert = hasCustomRule ? (userConstraint.enableAlert === true) : false;

                            if (durationHours > maxHours) {
                                if (enableAutoOut) {
                                    shift.end = new Date(startTime.getTime() + maxHours * 3600000).getTime();
                                    shift.note = (shift.note || "") + ` [Auto-Checkout: ${maxHours}h limit]`;
                                    changed = true;
                                    results.closed++;

                                    this.logMaintenance('CHECKOUT', `Closed shift for ${user} in ${client.businessName}`, { duration: durationHours.toFixed(2), limit: maxHours });

                                    if (enableAlert && companyConfig.adminEmail) {
                                        const summary = await this.getIndividualShiftSummary(client.id, year, month, shift);
                                        emailService.sendShiftAlert(
                                            companyConfig.adminEmail,
                                            user,
                                            "FORCE_OUT",
                                            shift.end,
                                            shift.location || "-",
                                            companyConfig.businessName || client.id,
                                            `המשמרת נסגרה אוטומטית כי חרגה מהמגבלה של ${this.formatHHMM(maxHours)} שעות.`,
                                            companyConfig.logoUrl,
                                            summary
                                        ).catch(e => console.error(`[Auto-Checkout Email FAIL] ${e.message}`));
                                    }
                                }
                                else if (enableAlert && !shift.maxAlertSent) {
                                    shift.maxAlertSent = true;
                                    changed = true;
                                    this.logMaintenance('CHECKOUT', `Warning alert for ${user} in ${client.businessName} (Duration: ${durationHours.toFixed(2)}h)`);

                                    if (companyConfig.adminEmail) {
                                        emailService.sendShiftAlert(
                                            companyConfig.adminEmail,
                                            user,
                                            "ALERT_MAX",
                                            now.getTime(),
                                            shift.location || "-",
                                            companyConfig.businessName || client.id,
                                            `העובד נמצא במשמרת פעילה מעל ${this.formatHHMM(maxHours)} שעות (נוכחי: ${this.formatHHMM(durationHours)}).`,
                                            companyConfig.logoUrl
                                        ).catch(e => console.error(`[Max Alert Email FAIL] ${e.message}`));
                                    }
                                }
                            }
                        }
                    }
                }

                if (changed) {
                    await this.saveShifts(client.id, year, month, shiftsData);
                }

            } catch (e) {
                results.errors.push(`Error for ${client.id}: ${e.message}`);
                this.logMaintenance('ERROR', `Checkout error for ${client.id}: ${e.message}`);
            }
        }
        return results;
    }

    async extendSubscription(companyId, planId, price, paymentMethod = null) {
        const client = await this.getClientById(companyId);
        if (!client) throw new Error("Company not found");

        const systemConfig = await this.getSystemConfig();
        // Plans are stored under tranzilaPlans key in system_config.json
        const plan = (systemConfig.tranzilaPlans || systemConfig.plans)?.find(p => String(p.id) === String(planId));
        if (!plan) throw new Error(`Plan not found: id=${planId}. Available plans: ${JSON.stringify((systemConfig.tranzilaPlans || systemConfig.plans || []).map(p => p.id))}`);

        const monthsToAdd = plan.months || 1;
        const now = new Date();
        let currentExpiry = this.parseExpiryDate(client.subscriptionExpiry || client.expiryDate);

        let targetDate;
        if (currentExpiry < now) {
            // Expired: Start from the very next billing date (1st of next month @ 04:00)
            targetDate = this.getNextBillingDate();
        } else {
            // Active: Base on current expiry
            targetDate = this.parseExpiryDate(currentExpiry);
        }

        // Add the months from the plan
        targetDate.setMonth(targetDate.getMonth() + monthsToAdd);

        // Ensure it aligns with the 1st @ 04:00
        targetDate.setDate(1);
        targetDate.setHours(4, 0, 0, 0);

        client.subscriptionExpiry = targetDate.toISOString();

        // Reset the billing baseline after a successful manual payment/settlement
        try {
            const activeEmployees = await this.countUniqueActiveEmployees(client.id);
            client.lastBilledEmployeeCount = activeEmployees;
        } catch (err) {
            console.error(`[DataManager] Baseline reset failed for ${client.id}:`, err.message);
        }

        // Save Payment Method if provided
        if (paymentMethod && paymentMethod.token) {
            const { businessId, ...pMethodSafe } = paymentMethod;
            client.paymentMethod = {
                token: pMethodSafe.token,
                last4: pMethodSafe.last4,
                expMonth: pMethodSafe.expMonth || pMethodSafe.expmonth,
                expYear: pMethodSafe.expYear || pMethodSafe.expyear,
                cardHolderId: pMethodSafe.cardHolderId,
                cardHolderName: pMethodSafe.cardHolderName,
                cvv: pMethodSafe.cvv,
                businessId: businessId || pMethodSafe.businessId // Keep for automated receipts
            };
            client.autoChargeEnabled = true; // Auto-enable if card added/updated
            
            if (businessId) {
                await this.updateCompanyConfig(companyId, { invoiceDetails: businessId });
            }
        }

        // Log payment
        if (!client.paymentHistory) client.paymentHistory = [];
        client.paymentHistory.push({
            date: new Date().toISOString(),
            amount: price,
            currency: plan.currency,
            period: monthsToAdd,
            method: 'Tranzila',
            reference: `PLAN-${planId}-${Date.now()}`,
            status: 'PAID'
        });

        // Report to GAS
        this.reportPaymentToGAS(price).catch(e => console.error(`[DataManager] GAS Report Failed: ${e.message}`));

        // Save
        await this.saveClients();
        return client;
    }

    async runMonthlyReports(year = null, month = null) {
        const now = new Date();
        const y = year || now.getFullYear();
        const m = month || (now.getMonth() + 1);

        this.logMaintenance('REPORTS', `Starting monthly reports generation for ${m}/${y}`);

        let sent = 0;
        let skip = 0;
        let errors = 0;

        for (const client of CACHE.clients) {
            try {
                const bizConfig = await this.getCompanyConfig(client.id);
                if (!bizConfig.adminEmail) {
                    skip++;
                    continue;
                }

                // Calculate report data for the target month
                const dashboard = await this.getDashboard(client.id, y, m);

                // Only send if there's any data or if it's explicitly requested
                const hasData = dashboard.some(d => parseFloat(d.monthlyTotal.replace(':', '.')) > 0);

                if (!hasData) {
                    this.logMaintenance('REPORTS', `Skipping ${client.businessName} (No hours found for ${m}/${y})`);
                    skip++;
                    continue;
                }

                await emailService.sendMonthlyReport(
                    bizConfig.adminEmail,
                    dashboard,
                    y, m,
                    bizConfig.businessName || client.businessName,
                    bizConfig.settings?.salary || {},
                    client.id,
                    bizConfig.logoUrl
                );

                this.logMaintenance('REPORTS', `ג… Sent report to ${client.businessName} (${bizConfig.adminEmail})`);
                sent++;
            } catch (e) {
                this.logMaintenance('ERROR', `ג Failed report for ${client.businessName}: ${e.message}`);
                errors++;
            }
        }

        this.logMaintenance('REPORTS', `Finished: ${sent} sent, ${skip} skipped, ${errors} errors.`);
        return { success: true, sent, skip, errors };
    }

    async checkSubscriptions(isManual = false) {
        const now = new Date();
        const results = { expired: 0, valid: 0, charged: 0, failures: [] };
        const sysConfig = await this.getSystemConfig();

        this.logMaintenance('BILLING', `${isManual ? 'Manual' : 'Automated'} per-client subscription and renewal check started. (Hourly Execution)`);

        for (const client of CACHE.clients) {
            try {
                const res = await this.processSingleClientSubscription(client, isManual, sysConfig, now);
                if (res.charged) results.charged++;
                if (res.expired) results.expired++;
                if (res.valid) results.valid++;
                if (res.failure) results.failures.push(res.failure.error);
            } catch (err) {
                this.logMaintenance('ERROR', `Sub-check failed for ${client.id}: ${err.message}`);
                results.failures.push(err.message);
            }
        }
        return results;
    }

    /**
     * Triggers a real charge and renewal for a specific client (Manual Action).
     */
    async chargeClientManually(clientId) {
        const client = CACHE.clients.find(c => c.id === clientId);
        if (!client) throw new Error(`Business ID ${clientId} not found`);

        const sysConfig = await this.getSystemConfig();
        const now = new Date();

        // Process with isManual=true to bypass the "1 day before" imminent check
        const res = await this.processSingleClientSubscription(client, true, sysConfig, now);
        
        if (res.error) {
            return { success: false, message: res.error, code: res.code };
        }
        
        return { 
            success: true, 
            message: `חיוב וחידוש המנוי של ${client.businessName} בוצעו בהצלחה`,
            confirmationCode: res.confirmCode
        };
    }

    /**
     * Core logic for processing a single client's subscription/charge cycle.
     * Supports both automated hourly scans and manual per-business triggers.
     */
    async processSingleClientSubscription(client, isManual, sysConfig, now = new Date()) {
        const res = { charged: false, expired: false, valid: true, failure: null };
        if (!client.subscriptionExpiry) return res;

        const expiry = this.parseExpiryDate(client.subscriptionExpiry);
        const hoursLeft = (expiry - now) / (1000 * 60 * 60);
        const daysLeft = hoursLeft / 24;
        
        // --- PRECISION BILLING SAFEGUARDS ---
        // 1. Charge only if expiry is in <= 1 day, OR if it's a forced manual override
        const isImminentOrExpired = daysLeft <= 1;
        const shouldForce = isManual; 
        
        // 2. Globally auto-billing must be ON (tied to terminal credentials)
        const globalAutoBilling = !!(sysConfig.tranzilaTerminal && sysConfig.tranzilaPass);
        
        // 3. System-wide auto-renewal is tied to the same credentials
        const globalAutoRenewal = globalAutoBilling;

        // Perform charge only if imminent/expired OR manual, AND has token, AND billing is globally enabled (or manual bypass)
        if ((isImminentOrExpired || shouldForce) && client.paymentMethod?.token && (globalAutoBilling || isManual)) {
            const activeCount = await this.countUniqueActiveEmployees(client.id);
            const subRes = await this.calculateSubscriptionAmount(client.id);
            const amount = subRes.amount;

            let chargeRes = { success: true, confirmationCode: 'FREE-RENEWAL', raw: 'סכום 0 ₪ - חודש חינם' };
            
            // Get App Name for product description
            const appName = sysConfig.appName || 'TempusGeo';
            // Fix: Clearer description for 0 employees
            const pdesc = activeCount === 0 ? `עלות מנוי מינימלית - ${appName}` : `${appName} - מנוי ל-${activeCount} עובדים`;

            if (amount >= 1) {
                this.logMaintenance('BILLING', `🔄 Executing ${isManual ? 'MANUAL' : 'AUTOMATED'} charge for ${client.businessName} (₪${amount})`);

                // Ensure Expiry Format (MMYY) - Robust check for all variations
                const pMethod = client.paymentMethod || {};
                const mmRaw = String(pMethod.expMonth || pMethod.expmonth || '00').padStart(2, '0');
                const yyRaw = String(pMethod.expYear || pMethod.expyear || '00');
                
                // Tranzila direct API expects 2 digits, but we derive from whatever length we have
                const mm = mmRaw.slice(-2);
                const yy = yyRaw.length === 4 ? yyRaw.slice(-2) : yyRaw.padStart(2, '0');

                chargeRes = await tranzilaService.chargeToken({
                    supplier: sysConfig.tranzilaTerminal,
                    TranzilaPW: sysConfig.tranzilaPass,
                    sum: amount,
                    currency: 1,
                    pdesc: pdesc,
                    TranzilaTK: client.paymentMethod.token,
                    expmonth: mm,
                    expyear: yy,
                    myid: client.paymentMethod.cardHolderId || '', 
                    company: client.invoiceDetails || client.businessName, 
                    contact: '', 
                    mycvv: client.paymentMethod.cvv
                });
            }

            if (chargeRes.success) {
                client.billingFailed = false;
                this.logMaintenance('BILLING', `✅ Payment approved for ${client.businessName} (₪${amount})`);
                
                this.reportPaymentToGAS(amount).catch(err => console.error(`[DataManager] GAS Report Failed:`, err.message));

                if (!client.paymentHistory) client.paymentHistory = [];
                client.paymentHistory.push({
                    date: new Date().toLocaleDateString('he-IL'),
                    fullDate: new Date().toISOString(),
                    amount,
                    currency: 'ILS',
                    description: `${isManual ? 'חיוב והארכה ידנית' : 'חידוש מנוי אוטומטי'} - ${activeCount} עובדים`,
                    method: isManual ? 'Manual-Admin' : 'Auto-Billing',
                    status: 'PAID',
                    statusDisplayName: 'שולם',
                    reference: chargeRes.confirmationCode
                });
                res.charged = true;
                res.confirmCode = chargeRes.confirmationCode;

                if ((client.autoChargeEnabled || isManual) && globalAutoRenewal) {
                    const nextExpiry = this.parseExpiryDate(expiry);
                    // If far in the past, renew from TODAY instead of compounding legacy months
                    if (expiry < now) nextExpiry.setTime(now.getTime());
                    
                    nextExpiry.setMonth(nextExpiry.getMonth() + 1);
                    nextExpiry.setDate(1);
                    nextExpiry.setHours(4, 0, 0, 0);

                    client.subscriptionExpiry = nextExpiry.toISOString();
                    client.subscriptionDate = (expiry < now ? now : expiry).toISOString();
                    
                    this.logMaintenance('RENEWAL', `✅ Subscription extended for ${client.businessName}. Next: ${nextExpiry.toLocaleDateString('he-IL')} 04:00`);
                }

                client.lastBilledEmployeeCount = activeCount;
                await this.saveClients();
            } else {
                client.billingFailed = true;
                this.logMaintenance('BILLING', `❌ Payment rejected for ${client.businessName}: ${chargeRes.raw || 'Bank decline'}`);
                res.error = chargeRes.raw || 'Bank decline';
                res.code = chargeRes.confirmationCode;
                res.failure = { id: client.id, name: client.businessName, error: res.error };
                
                // Alert client in case of automated failure
                if (!isManual) {
                    emailService.sendPaymentFailedNotification(client.email, {
                        businessName: client.businessName,
                        amount: amount,
                        error: res.error
                    }).catch(console.error);
                }
            }
        }

        // --- EXPIRY ALERTS ---
        const noticeHours = 2 * 24; // Strict 2-day warning
        if (!client.autoChargeEnabled && hoursLeft > 0 && hoursLeft <= noticeHours && client.lastExpiryAlertDate !== client.subscriptionExpiry) {
            res.expired = true;
            const bizConfig = await this.getCompanyConfig(client.id);
            const subRes = await this.calculateSubscriptionAmount(client.id);
            
            emailService.sendSubscriptionAlert(
                client.email,
                client.businessName,
                Math.ceil(hoursLeft / 24),
                client.subscriptionExpiry,
                bizConfig.logoUrl,
                subRes.amount
            ).then(() => {
                client.lastExpiryAlertDate = client.subscriptionExpiry;
                this.saveClients().catch(console.error);
            }).catch(console.error);
            
            this.logMaintenance('RENEWAL', `Sent expiry alert to ${client.businessName}`);
        } else if (expiry < now) {
            res.expired = true;
        }

        return res;
    }
    async getFileContent(fileName) {
        if (!fileName.endsWith('.json')) {
            throw new Error('Only JSON files can be read through this interface.');
        }

        const safeName = path.basename(fileName);
        const filePath = path.join(this.dataDir, safeName);

        try {
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            throw new Error('File not found or unreadable: ' + fileName);
        }
    }
}

module.exports = new DataManager();
