const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const axios = require('axios');

// --- IN-MEMORY CACHE ---
// Structure: { companyId: { config: {}, shifts: { '2024-02': { ...data... } } } }
const CACHE = {
    clients: [], // Array of client objects
    companies: {},
    historicalData: {} // Cache for cold data from GAS: { companyId: { 'year-month': data } }
};

// HOT STORAGE CONFIG
const HOT_STORAGE_MONTHS = 2; // Keep current + last month

class DataManager {
    constructor() {
        this.dataDir = config.DATA_DIR;
        this.clientsFile = path.join(this.dataDir, 'clients.json');
        this.metadataFile = path.join(this.dataDir, 'metadata.json');
        this.init();
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
            await this.smartRestoreFromGAS(localTime);

            // 4. Load All Companies into RAM (Warmup)
            for (const client of CACHE.clients) {
                await this.loadCompany(client.id);
            }

        } catch (e) {
            console.error("Critical Error initializing DataManager:", e);
        }
    }

    // --- CLIENTS / AUTH ---

    async getClientById(id) {
        return CACHE.clients.find(c => c.id === id);
    }

    async saveClients() {
        await fs.writeFile(this.clientsFile, JSON.stringify(CACHE.clients, null, 2));
        await this.updateLastWriteTime();
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

        CACHE.companies[companyId] = {
            config: configData,
            shifts: {} // Will load shifts on demand per month
        };
    }

    async getCompanyConfig(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const config = { ...CACHE.companies[companyId].config };

        // DYNAMICALLY INJECT SUBSCRIPTION STATUS
        // This overrides any stale 'subscriptionExpired' in the config file
        const client = await this.getClientById(companyId);
        if (client) {
            const now = new Date();
            const expiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : now;

            config.subscriptionExpired = expiry < now;
            config.expiryDate = expiry.toLocaleDateString('he-IL');
        }

        return config;
    }

    async getAllClientsWithStatus() {
        const now = new Date();
        // Return enriched client objects
        return Promise.all(CACHE.clients.map(async (client) => {
            // Ensure config is loaded to get latest details if needed, 
            // but primarily we need the subscription expiry from the client object itself.
            // We reuse getCompanyConfig logic to ensure consistency? 
            // Actually getCompanyConfig *reads* from client object.

            const expiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : new Date(0); // Default to old if missing
            const daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
            const isExpired = expiry < now;

            return {
                companyId: client.id,
                businessName: client.businessName,
                email: client.email || '',
                phone: client.phone || '',
                subscriptionExpiry: client.subscriptionExpiry,
                expiryDate: expiry.toLocaleDateString('he-IL'),
                isExpired: isExpired,
                daysRemaining: daysRemaining
            };
        }));
    }

    async updateCompanyConfig(companyId, newConfig) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        // Merge deep
        const current = CACHE.companies[companyId].config;

        // Specific logic for salary/constraints/adminEmail
        // We just merge everything passed in 'newConfig'
        const updated = { ...current, ...newConfig };

        // RAM Update
        CACHE.companies[companyId].config = updated;

        // Disk Update
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        await fs.mkdir(companyDir, { recursive: true });
        await fs.writeFile(path.join(companyDir, 'config.json'), JSON.stringify(updated, null, 2));
        await this.updateLastWriteTime();

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
        const configFile = path.join(this.dataDir, 'system_config.json');
        try {
            const data = await fs.readFile(configFile, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            return {}; // Return empty if not exists
        }
    }

    async updateSystemConfig(newConfig) {
        const current = await this.getSystemConfig();
        const updated = { ...current, ...newConfig };
        const configFile = path.join(this.dataDir, 'system_config.json');
        await fs.writeFile(configFile, JSON.stringify(updated, null, 2));
        await this.updateLastWriteTime();
        return updated;
    }

    // --- SHIFTS & ATTENDANCE ---

    async getShifts(companyId, year, month) {
        // key format: '2024-01'
        // month is 0-indexed in JS Date, but let's use 1-12 for file names for clarity.
        // Actually, let's stick to the "Year" folder structure to match GAS.

        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const cacheKey = `${year}-${month}`; // e.g., 2024-1 (January)

        if (CACHE.companies[companyId].shifts[cacheKey]) {
            return CACHE.companies[companyId].shifts[cacheKey];
        }

        // Load from Disk
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        const yearDir = path.join(companyDir, year.toString());
        const fileName = `${month}.json`; // e.g., "1.json" for January
        const filePath = path.join(yearDir, fileName);

        let shifts = {};
        try {
            const data = await fs.readFile(filePath, 'utf8');
            shifts = JSON.parse(data);
        } catch (e) {
            // File doesn't exist yet
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

        const filePath = path.join(yearDir, `${month}.json`);
        await fs.writeFile(filePath, JSON.stringify(shiftsData, null, 2));
        await this.updateLastWriteTime();
    }


    async getEmployeeStatus(companyId, employeeName) {
        // Fast RAM lookup
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        // We need to check today's shift
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const shifts = await this.getShifts(companyId, year, month);

        // Check if employee has an open shift in current month
        // Structure of 'shifts': { "Employee Name": [ { start, end }, ... ] }
        const empShifts = shifts[employeeName] || [];
        const lastShift = empShifts[empShifts.length - 1];

        if (lastShift && !lastShift.end) {
            return { state: "IN", startTime: lastShift.start };
        }

        return { state: "OUT" };
    }

    async getEmployees(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;

        // Ensure current month is loaded
        await this.getShifts(companyId, year, month);

        const currentShifts = CACHE.companies[companyId].shifts[`${year}-${month}`] || {};
        const employees = Object.keys(currentShifts);

        return employees.sort();
    }

    async logShift(companyId, employeeName, action, timestamp, location, note) {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;

        const shifts = await this.getShifts(companyId, year, month);

        if (!shifts[employeeName]) shifts[employeeName] = [];

        if (action === "IN") {
            shifts[employeeName].push({ start: timestamp, end: null, location });
        } else if (action === "OUT") {
            const lastShift = shifts[employeeName][shifts[employeeName].length - 1];
            if (lastShift && !lastShift.end) {
                lastShift.end = timestamp;
                if (note) lastShift.note = note; // Add note if provided
            } else {
                shifts[employeeName].push({ start: null, end: timestamp, note: "Manual Out without In" });
            }
        }

        await this.saveShifts(companyId, year, month, shifts);

        // --- EMAIL NOTIFICATION (If Enabled) ---
        try {
            const companyConfig = await this.getCompanyConfig(companyId);
            if (companyConfig.settings && companyConfig.settings.emailOnShiftChange && companyConfig.adminEmail) {
                // Don't await this, let it run in background
                emailService.sendShiftAlert(
                    companyConfig.adminEmail,
                    employeeName,
                    action,
                    timestamp,
                    location,
                    companyConfig.businessName
                ).catch(e => console.error(`[Email Alert] Failed to send shift alert: ${e.message}`));
            }
        } catch (e) {
            console.error(`[Email Alert] Error checking config: ${e.message}`);
        }

        return { success: true };
    }

    // --- DASHBOARD ---
    async getDashboard(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;

        // Ensure current month loaded
        const shifts = await this.getShifts(companyId, year, month);
        const employees = await this.getEmployees(companyId);

        const dashboard = [];

        for (const emp of employees) {
            const empShifts = shifts[emp] || [];
            const lastShift = empShifts[empShifts.length - 1];

            // Calculate daily total
            let dailyTotal = 0;
            const todayStr = now.toDateString();

            empShifts.forEach(s => {
                const sDate = new Date(s.start || s.end);
                if (sDate.toDateString() === todayStr) {
                    if (s.end && s.start) {
                        dailyTotal += (new Date(s.end) - new Date(s.start)) / 3600000;
                    } else if (s.start && !s.end) {
                        // Active shift - calculating duration until now
                        dailyTotal += (now - new Date(s.start)) / 3600000;
                    }
                }
            });

            dashboard.push({
                name: emp,
                status: (lastShift && !lastShift.end) ? 'IN' : 'OUT',
                time: (lastShift && !lastShift.end) ? lastShift.start : (lastShift ? lastShift.end : null),
                duration: dailyTotal.toFixed(2),
                weekly: '0.00' // Placeholder if not calculating weekly yet
            });
        }

        return dashboard;
    }

    // --- HISTORY META ---
    async getHistoryYears(companyId) {
        // Try getting from Hot Storage fs
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        const years = new Set();

        try {
            const files = await fs.readdir(companyDir);
            for (const file of files) {
                if (file === 'config.json') continue;
                // check if dir
                const stat = await fs.stat(path.join(companyDir, file));
                if (stat.isDirectory()) years.add(parseInt(file));
            }
        } catch (e) { }

        return Array.from(years).sort((a, b) => b - a);
    }

    async getHistoryMonths(companyId, year) {
        const yearDir = path.join(this.dataDir, 'companies', companyId, year.toString());
        const months = [];
        try {
            const files = await fs.readdir(yearDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    months.push(parseInt(file.replace('.json', '')));
                }
            }
        } catch (e) { }
        return months.sort((a, b) => b - a);
    }

    // --- ADMIN ACTIONS ---

    async adminSaveShift(companyId, { year, month, name, originalStart, newStart, newEnd }) {
        const shifts = await this.getShifts(companyId, parseInt(year), parseInt(month));
        if (!shifts[name]) return;

        const shiftIndex = shifts[name].findIndex(s => s.start === originalStart || (new Date(s.start).getTime() === new Date(originalStart).getTime()));
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

    async adminDeleteShift(companyId, { year, month, name, start }) {
        const shifts = await this.getShifts(companyId, parseInt(year), parseInt(month));
        if (!shifts[name]) return;

        // Filter out by start time
        shifts[name] = shifts[name].filter(s => s.start !== start && new Date(s.start).getTime() !== new Date(start).getTime());
        await this.saveShifts(companyId, parseInt(year), parseInt(month), shifts);
    }

    async adminForceAction(companyId, { name, forceType }) {
        // forceType: 'checkIn' | 'checkOut'
        await this.logShift(companyId, name, forceType === 'checkIn' ? 'IN' : 'OUT', Date.now(), 'Admin Force', 'Forced by Admin');
    }

    // --- EMPLOYEE MANAGEMENT ---

    async addEmployee(companyId, name) {
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
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const shifts = await this.getShifts(companyId, year, month);

        if (shifts[name]) {
            delete shifts[name];
            await this.saveShifts(companyId, year, month, shifts);
        }
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
            const gasUrl = config.GAS_COLD_STORAGE_URL;
            if (!gasUrl) {
                console.warn('[Cold Data] GAS_COLD_STORAGE_URL not configured');
                return {};
            }

            console.log(`[Cold Data] Fetching from GAS: ${companyId}/${year}/${month}`);
            const response = await axios.get(`${gasUrl}/history/${companyId}/${year}/${month}`, {
                timeout: 5000
            });

            const data = response.data;

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

            console.log('[Restore] Checking GAS for updates...');
            const response = await axios.get(`${gasUrl}?path=restore`, { timeout: 30000 });

            if (!response.data || !response.data.success) {
                console.error('[Restore] GAS returned failure.');
                return false;
            }

            const backup = response.data.data;
            const remoteTime = backup.metadata ? backup.metadata.lastWriteTime : 0;

            console.log(`[Restore] Remote Timestamp: ${new Date(remoteTime).toISOString()}`);

            // DECISION LOGIC:
            // 1. If we have NO local data (localTime = 0), Restore.
            // 2. If Remote is NEWER than Local (remoteTime > localTime), Restore.
            // 3. Otherwise, stick with Local.

            if (localTime > 0 && localTime >= remoteTime) {
                console.log('[Restore] Local data is up-to-date. Skipping restore.');
                return true;
            }

            console.log(`[Restore] Restoring from GAS (Remote ${remoteTime} > Local ${localTime})...`);

            // Generic Restore
            if (backup.files && Array.isArray(backup.files)) {
                console.log(`[Restore] Restoring ${backup.files.length} generic files...`);
                for (const file of backup.files) {
                    try {
                        const fullPath = path.join(this.dataDir, file.path);
                        const dirPath = path.dirname(fullPath);
                        await fs.mkdir(dirPath, { recursive: true });
                        await fs.writeFile(fullPath, JSON.stringify(file.content, null, 2));
                    } catch (e) {
                        console.error(`[Restore] Failed to write file ${file.path}:`, e);
                    }
                }

                // Reload Cache immediately after generic restore
                await this.loadAllToCache();
            }

            // Sync Timestamp to match Remote
            if (remoteTime > 0) {
                await fs.writeFile(this.metadataFile, JSON.stringify({ lastWriteTime: remoteTime }));
            }

            console.log('[Restore] Restoration Complete!');
            return true;

        } catch (e) {
            console.error(`[Restore] Critical Failure: ${e.message}`);
            return false;
        }
    }

    // --- EXPORT ---

    async getFullHistoryForExport(companyId) {
        // 1. Get all Hot Data from Disk
        // 2. Try to get Cold Data from GAS? (Might be too heavy)
        // 3. For MVP: Just Zip what we have locally (Hot Storage)

        // Ideally we should have a way to ask GAS for a full dump URL, 
        // but User wants Render to be the boss.
        // Let's iterate all local files first.

        const companyDir = path.join(this.dataDir, 'companies', companyId);
        // We'll return paths of files to be zipped
        const filePaths = [];

        try {
            const years = await fs.readdir(companyDir);
            for (const year of years) {
                if (year === 'config.json') continue;
                const yearDir = path.join(companyDir, year);
                const months = await fs.readdir(yearDir);
                for (const month of months) {
                    filePaths.push({
                        name: `${year}_${month}`,
                        path: path.join(yearDir, month)
                    });
                }
            }
        } catch (e) { }

        return filePaths;
    }

    async createBusiness(data) {
        // data: { businessName, email, phone, password, ... }
        // Simple 4 digit ID loop
        let newId;
        do {
            newId = Math.floor(1000 + Math.random() * 9000).toString();
        } while (CACHE.companies[newId] || CACHE.clients.find(c => c.id === newId));

        const client = {
            id: newId,
            businessName: data.businessName,
            email: data.email,
            phone: data.phone,
            password: data.password, // Hash this in real app!
            subscriptionExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days trial
            joinedAt: new Date().toISOString()
        };

        CACHE.clients.push(client);
        await this.saveClients();

        const config = {
            companyId: newId,
            businessName: data.businessName,
            settings: {},
            polygon: [],
            adminEmail: data.email,
            logoUrl: data.logoUrl
        };

        await this.updateCompanyConfig(newId, config);

        return client;
    }

    // --- MAINTENANCE TASKS ---

    async performAutoCheckout() {
        const now = new Date();
        const results = { checked: 0, closed: 0, errors: [] };

        for (const client of CACHE.clients) {
            try {
                results.checked++;
                const year = now.getFullYear();
                const month = now.getMonth() + 1;

                // Get shifts (Hot only for checkout)
                const shiftsData = await this.getShifts(client.id, year, month);
                let changed = false;

                for (const [user, shifts] of Object.entries(shiftsData)) {
                    for (const shift of shifts) {
                        if (!shift.end && shift.start) {
                            const startTime = new Date(shift.start);
                            const durationHours = (now - startTime) / 3600000;

                            // Close if > 12 hours
                            if (durationHours > 12) {
                                shift.end = new Date(startTime.getTime() + 12 * 3600000).toISOString();
                                shift.note = (shift.note || "") + " [Auto-Checkout: 12h limit]";
                                changed = true;
                                results.closed++;
                            }
                        }
                    }
                }

                if (changed) {
                    await this.saveShifts(client.id, year, month, shiftsData);
                }

            } catch (e) {
                results.errors.push(`Error for ${client.id}: ${e.message}`);
            }
        }
        return results;
    }

    async extendSubscription(companyId, planId, price) {
        const client = await this.getClientById(companyId);
        if (!client) throw new Error("Company not found");

        const systemConfig = await this.getSystemConfig();
        const plan = systemConfig.plans?.find(p => p.id === planId);
        if (!plan) throw new Error("Plan not found");

        const monthsToAdd = plan.months || 1;
        const now = new Date();
        let currentExpiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : now;

        // If expired, start from now. If active, add to existing expiry.
        if (currentExpiry < now) {
            currentExpiry = now;
        }

        // Add months
        currentExpiry.setMonth(currentExpiry.getMonth() + monthsToAdd);

        client.subscriptionExpiry = currentExpiry.toISOString();

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

        // Save
        await this.saveClients();
        return client;
    }

    async checkSubscriptions() {
        const now = new Date();
        const results = { expired: 0, valid: 0 };

        for (const client of CACHE.clients) {
            if (client.subscriptionExpiry && client.email) {
                const expiry = new Date(client.subscriptionExpiry);
                const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));

                if (daysLeft <= 3) { // Notify if expired or expiring soon (3 days)
                    results.expired++; // Keeping stats simple

                    // Send alert (limit to once a day logic needed? 
                    //Ideally we'd track 'lastAlertSent' but for now it's daily trigger)

                    emailService.sendSubscriptionAlert(
                        client.email,
                        client.businessName,
                        daysLeft,
                        client.subscriptionExpiry
                    ).catch(console.error);
                } else {
                    results.valid++;
                }
            }
        }
        return results;
    }

    async getStorageStats() {
        const sizes = { total: 0, items: [] };

        const readDirRec = async (dir, relativePath = '') => {
            try {
                const files = await fs.readdir(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    const relPath = path.join(relativePath, file);
                    const stat = await fs.stat(fullPath);
                    if (stat.isDirectory()) {
                        await readDirRec(fullPath, relPath);
                    } else {
                        sizes.total += stat.size;
                        sizes.items.push({ name: relPath, size: stat.size, timestamp: stat.mtimeMs });
                    }
                }
            } catch (e) { /* ignore missing dirs */ }
        };

        await readDirRec(this.dataDir);
        sizes.items.sort((a, b) => b.size - a.size);
        sizes.items = sizes.items.slice(0, 100); // Only keep top 100 largest files
        return sizes;
    }
}


module.exports = new DataManager();
