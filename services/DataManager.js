const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const axios = require('axios');
const emailService = require('./EmailService');

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

            // 5. Start Automatic Archiving Trigger (Every 24 hours)
            setInterval(() => {
                console.log(`[Auto-Archive] Starting daily cleanup cycle...`);
                this.runGlobalArchiveCycle().catch(e => console.error(`[Auto-Archive] Global Cycle Failed:`, e.message));
            }, 24 * 60 * 60 * 1000);

            // Trigger once on startup after 1 minute
            setTimeout(() => {
                this.runGlobalArchiveCycle().catch(e => console.error(`[Startup Clean] Failed:`, e.message));
            }, 60000);

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
            shifts: {} // Will load shifts on demand per month
        };
    }


    async getCompanyConfig(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const config = { ...CACHE.companies[companyId].config };

        // DYNAMICALLY INJECT SUBSCRIPTION STATUS AND BUSINESS NAME
        // This overrides any stale data in the config file
        const client = await this.getClientById(companyId);
        if (client) {
            const now = new Date();
            const expiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : now;

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

        // Fetch company config to check for hybrid status
        const config = await this.getCompanyConfig(companyId);
        const settings = config.settings || {};
        const isHybrid = settings.constraints && settings.constraints[employeeName] && settings.constraints[employeeName].isHybrid ? true : false;

        if (lastShift && !lastShift.end) {
            return { state: "IN", startTime: lastShift.start, isHybrid };
        }

        return { state: "OUT", isHybrid };
    }

    async getEmployees(companyId) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

        const config = CACHE.companies[companyId].config;

        // If config has employees, return them
        if (config.employees && config.employees.length > 0) {
            return config.employees.sort();
        }

        // Fallback: If employees list is empty in config, try to extract from current/previous months
        // to migrate them into the config
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;

        const monthsToCheck = [
            { y: year, m: month },
            { y: month === 1 ? year - 1 : year, m: month === 1 ? 12 : month - 1 }
        ];

        const employeeSet = new Set();
        for (const m of monthsToCheck) {
            const shifts = await this.getShifts(companyId, m.y, m.m);
            Object.keys(shifts).forEach(name => employeeSet.add(name));
        }

        const employees = Array.from(employeeSet).sort();

        if (employees.length > 0) {
            config.employees = employees;
            await this.updateCompanyConfig(companyId, config);
        }

        return employees;
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

            // Calculate distance if coordinates provided
            let distanceStr = null;
            if (location && typeof location === 'object' && location.lat && location.lng) {
                const distMeters = this.calculateDistanceToPolygon(location.lat, location.lng, companyConfig.polygon);
                if (distMeters === 0) {
                    distanceStr = "בתוך המשרד";
                } else if (distMeters < 1000) {
                    distanceStr = `${Math.round(distMeters)} מטרים מהמשרד`;
                } else {
                    distanceStr = `${(distMeters / 1000).toFixed(1)} ק"מ מהמשרד`;
                }

                // Store distance in shift record for reporting
                const shifts = await this.getShifts(companyId, year, month);
                const lastShift = shifts[employeeName][shifts[employeeName].length - 1];
                if (lastShift) {
                    lastShift.distance = distanceStr;
                    await this.saveShifts(companyId, year, month, shifts);
                }
            }

            if (companyConfig.settings && companyConfig.settings.emailNotifications && companyConfig.adminEmail) {
                // Don't await this, let it run in background
                emailService.sendShiftAlert(
                    companyConfig.adminEmail,
                    employeeName,
                    action,
                    timestamp,
                    distanceStr || (typeof location === 'string' ? location : "-"),
                    companyConfig.businessName,
                    "",
                    companyConfig.logoUrl
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

    async getAvailableHolidays(companyId) {
        try {
            const configObj = await this.getCompanyConfig(companyId);
            const gasUrl = configObj?.gasUrl || config.GAS_COLD_STORAGE_URL;
            if (gasUrl) {
                const response = await axios.get(`${gasUrl}?action=getHolidays&companyId=${companyId}&password=${configObj?.password || ''}`, {
                    timeout: 5000
                });
                if (response.data && response.data.success && Array.isArray(response.data.holidays)) {
                    const holidays = response.data.holidays;
                    const events = response.data.events || {}; // { 'YYYY-MM-DD': ['Holiday'] }

                    // Map holidays to their date ranges
                    return holidays.map(hName => {
                        const name = typeof hName === 'string' ? hName : hName.name;

                        // Current timestamp and threshold (60 days ago)
                        const now = new Date();
                        const threshold = new Date(now.getTime() - (60 * 24 * 60 * 60 * 1000));
                        const thresholdStr = threshold.toISOString().split('T')[0];

                        // 1. Find all dates for this holiday and filter for relevance (from 60 days ago onwards)
                        const allDates = Object.keys(events).filter(d => events[d].includes(name)).sort();
                        const relevantDates = allDates.filter(d => d >= thresholdStr);

                        let displayDate = null;
                        if (relevantDates.length > 0) {
                            // 2. Identify the FIRST contiguous block (to avoid spanning multiple years)
                            const firstBlock = [];
                            firstBlock.push(relevantDates[0]);

                            for (let i = 1; i < relevantDates.length; i++) {
                                const prev = new Date(relevantDates[i - 1]);
                                const curr = new Date(relevantDates[i]);
                                const diffDays = (curr - prev) / (1000 * 60 * 60 * 24);

                                if (diffDays <= 1) { // Same day or next day is part of the same holiday block
                                    firstBlock.push(relevantDates[i]);
                                } else {
                                    // Gap found, we have our first occurrence block
                                    break;
                                }
                            }

                            const format = (dStr) => {
                                const [y, m, d] = dStr.split('-');
                                return `${d}/${m}/${y.slice(-2)}`;
                            };

                            if (firstBlock.length === 1) {
                                displayDate = format(firstBlock[0]);
                            } else {
                                displayDate = `${format(firstBlock[0])} - ${format(firstBlock[firstBlock.length - 1])}`;
                            }
                        }

                        return { name, displayDate };
                    });
                }
            }
        } catch (e) {
            console.error(`[Holidays] Failed to fetch from GAS for ${companyId}:`, e.message);
        }
        const defaults = Array.isArray(config.MAJOR_HOLIDAYS) ? config.MAJOR_HOLIDAYS : [];
        return defaults.map(h => ({ name: String(h), date: null }));
    }

    async getHolidayDatesForMonth(companyId, year, month) {
        const allHolidays = await this.getAvailableHolidays(companyId);
        if (!Array.isArray(allHolidays)) return [];

        const bizConfig = await this.getBusinessConfig(companyId);
        const selectedNames = bizConfig.salary?.holidays?.eligible || bizConfig.salary?.selectedHolidays || [];

        // Filter for specific month/year AND user selection
        return allHolidays
            .filter(h => {
                if (!h.date || !h.name) return false;
                const hDate = new Date(h.date);
                return hDate.getFullYear() === year &&
                    (hDate.getMonth() + 1) === month &&
                    selectedNames.includes(h.name);
            })
            .map(h => h.date); // Returns array of "yyyy-MM-dd"
    }

    // --- HISTORY META ---
    async getHistoryYears(companyId) {
        // Try getting from Hot Storage fs
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        const years = new Set();
        let config = null;

        try {
            config = await this.getCompanyConfig(companyId);
            const files = await fs.readdir(companyDir);
            for (const file of files) {
                if (file === 'config.json') continue;
                // check if dir
                const stat = await fs.stat(path.join(companyDir, file));
                if (stat.isDirectory()) years.add(parseInt(file));
            }
        } catch (e) { }

        // Fetch from GAS Cold Storage
        if (config && config.gasUrl) {
            try {
                const response = await axios.get(`${config.gasUrl}?action=getYears&companyId=${companyId}&password=${config.password}`);
                if (response.data && response.data.years) {
                    response.data.years.forEach(y => years.add(parseInt(y)));
                }
            } catch (err) {
                console.error(`[GAS] Failed to fetch archive years for ${companyId}: ${err.message}`);
            }
        }

        return Array.from(years).sort((a, b) => b - a);
    }

    async getHistoryMonths(companyId, year) {
        const yearDir = path.join(this.dataDir, 'companies', companyId, year.toString());
        const months = new Set();
        let config = null;

        try {
            config = await this.getCompanyConfig(companyId);
            const files = await fs.readdir(yearDir);
            for (const file of files) {
                // Support both "3.json" (Render default) and "json.3" (GAS format)
                let parsedOpts = NaN;
                if (file.endsWith('.json')) {
                    parsedOpts = parseInt(file.replace('.json', ''));
                } else if (file.startsWith('json.')) {
                    parsedOpts = parseInt(file.split('.')[1]);
                }

                // FIX: Ensure we only add valid numbers, ignore 'NaN.json' or 'undefined.json'
                if (!isNaN(parsedOpts)) {
                    months.add(parsedOpts);
                }
            }
        } catch (e) { }

        // Fetch from GAS Cold Storage
        if (config && config.gasUrl) {
            try {
                const response = await axios.get(`${config.gasUrl}?action=getMonths&companyId=${companyId}&year=${year}&password=${config.password}`);
                if (response.data && response.data.months) {
                    response.data.months.forEach(m => months.add(parseInt(m)));
                }
            } catch (err) {
                console.error(`[GAS] Failed to fetch archive months for ${companyId}: ${err.message}`);
            }
        }

        return Array.from(months).sort((a, b) => b - a);
    }

    // --- ADMIN ACTIONS ---

    async adminSaveShift(companyId, { year, month, name, originalStart, newStart, newEnd }) {
        const shifts = await this.getShifts(companyId, parseInt(year), parseInt(month));
        if (!shifts[name]) return;

        // Make sure to parse numeric strings (Epoch) correctly, as new Date("17727...") becomes Invalid Date.
        const safeGetTime = (t) => {
            if (!t) return null;
            if (typeof t === 'number') return new Date(t).getTime();
            if (typeof t === 'string' && !isNaN(t)) return new Date(parseInt(t)).getTime();
            return new Date(t).getTime();
        };

        const shiftIndex = shifts[name].findIndex(s => s.start === originalStart || s.start == originalStart || (safeGetTime(s.start) === safeGetTime(originalStart)));
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
        shifts[name] = shifts[name].filter(s => s.start !== start && s.start != start && safeGetTime(s.start) !== safeGetTime(start));
        await this.saveShifts(companyId, parseInt(year), parseInt(month), shifts);
    }

    async adminForceAction(companyId, { name, forceType }) {
        // forceType: 'checkIn' | 'checkOut'
        await this.logShift(companyId, name, forceType === 'checkIn' ? 'IN' : 'OUT', Date.now(), 'Admin Force', 'Forced by Admin');
    }

    // --- EMPLOYEE MANAGEMENT ---

    async addEmployee(companyId, name) {
        if (!CACHE.companies[companyId]) await this.loadCompany(companyId);
        const config = CACHE.companies[companyId].config;

        if (!config.employees) config.employees = [];

        if (!config.employees.includes(name)) {
            config.employees.push(name);
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

        if (config.employees) {
            config.employees = config.employees.filter(e => e !== name);
            await this.updateCompanyConfig(companyId, config);
        }

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
                try {
                    const clientsData = await fs.readFile(this.clientsFile, 'utf8');
                    CACHE.clients = JSON.parse(clientsData);
                } catch (e) {
                    console.log("[Restore] Could not reload clients.json into cache.");
                }

                // Clear companies cache and reload them
                CACHE.companies = {};
                for (const client of CACHE.clients) {
                    await this.loadCompany(client.id);
                }
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

    async getUserFullHistory(companyId, employeeName) {
        const allShifts = [];
        const seenKeys = new Set(); // Deduplicate by shift start timestamp

        const addShift = (s) => {
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
                const response = await axios.get(`${gasUrl}?action=getFullUserHistory&companyId=${companyId}&name=${encodeURIComponent(employeeName)}`, {
                    timeout: 20000
                });
                if (response.data && response.data.success && Array.isArray(response.data.shifts)) {
                    console.log(`[History] GAS returned ${response.data.shifts.length} cold shifts`);
                    response.data.shifts.forEach(addShift);
                } else {
                    // Fallback: fetch full archive and filter by employee
                    console.log('[History] Trying getFullArchive fallback...');
                    const r2 = await axios.get(`${gasUrl}?action=getFullArchive&companyId=${companyId}`, { timeout: 30000 });
                    if (r2.data && r2.data.success && Array.isArray(r2.data.data)) {
                        r2.data.data.forEach(s => {
                            // GAS getFullArchive stores all users' shifts together, filter by name
                            if (s.name === employeeName || !s.name) addShift(s);
                        });
                    }
                }
            } catch (e) {
                console.error(`[History] GAS fetch failed:`, e.message);
            }
        } else {
            console.warn('[History] GAS_COLD_STORAGE_URL not configured, cold data unavailable');
        }

        // 2. Merge with Hot (Local) Data from Render disk
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

        // Subscription Expiry Logic: Always ends on the 1st of the FOLLOWING month.
        // Example: Registered 7.3 -> Expiry 1.4.
        const trialExpiry = new Date();
        trialExpiry.setMonth(trialExpiry.getMonth() + 1);
        trialExpiry.setDate(1);
        trialExpiry.setHours(23, 59, 59, 999);

        const client = {
            id: newId,
            businessName: data.businessName,
            email: data.email,
            phone: data.phone,
            password: safePassword, // Store password here for admin login
            subscriptionExpiry: trialExpiry.toISOString(),
            joinedAt: new Date().toISOString()
        };

        CACHE.clients.push(client);
        await this.saveClients();

        const config = {
            companyId: newId,
            businessName: data.businessName,
            settings: {},
            polygon: data.polygon || [],
            adminEmail: data.email,
            logoUrl: data.logoUrl || null
        };

        await this.updateCompanyConfig(newId, config);

        return client;
    }

    async deleteBusiness(companyId) {
        // 1. Remove from clients array
        const initialLen = CACHE.clients.length;
        CACHE.clients = CACHE.clients.filter(c => c.id !== companyId);

        if (CACHE.clients.length === initialLen) {
            throw new Error('Business not found');
        }
        await this.saveClients();

        // 2. Remove from active cache
        if (CACHE.companies[companyId]) {
            delete CACHE.companies[companyId];
        }

        // 3. Delete from filesystem
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        try {
            await fs.rm(companyDir, { recursive: true, force: true });
        } catch (e) {
            console.error(`[DataManager] Error deleting directory for ${companyId}:`, e.message);
        }

        await this.updateLastWriteTime();
        return true;
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

                // Load config to get constraints
                const companyConfig = await this.getCompanyConfig(client.id);
                const constraints = companyConfig?.settings?.constraints || {};

                // Get shifts (Hot only for checkout)
                const shiftsData = await this.getShifts(client.id, year, month);
                let changed = false;

                for (const [user, shifts] of Object.entries(shiftsData)) {
                    for (const shift of shifts) {
                        if (!shift.end && shift.start) {
                            const startTime = new Date(parseInt(shift.start) || shift.start);
                            const durationHours = (now.getTime() - startTime.getTime()) / 3600000;

                            // Check per-user constraints or fallback to 12
                            const userConstraint = constraints[user] || {};

                            // Determine applicable rules based on Employee Constraints
                            const hasCustomRule = !!userConstraint.maxDuration;
                            const maxHours = hasCustomRule ? parseFloat(userConstraint.maxDuration) : 12;
                            const enableAutoOut = hasCustomRule ? (userConstraint.enableAutoOut === true) : true; // default true for 12h fallback

                            // Check global email setting as a fallback for Forced Checkouts
                            const globalEmailEnabled = companyConfig?.settings?.emailNotifications === true;
                            const enableAlert = hasCustomRule ? (userConstraint.enableAlert === true) : false; // default false for 12h fallback

                            if (durationHours > maxHours) {
                                // CASE 1: Auto Checkout Enforced -> Close shift & Send FORCE_OUT Alert
                                if (enableAutoOut) {
                                    shift.end = new Date(startTime.getTime() + maxHours * 3600000).getTime();
                                    shift.note = (shift.note || "") + ` [Auto-Checkout: ${maxHours}h limit]`;
                                    changed = true;
                                    results.closed++;

                                    // Send alert if explicitly enabled for user, OR if global emails are on (managers want to know about forced checkouts)
                                    if ((enableAlert || globalEmailEnabled) && companyConfig.adminEmail) {
                                        emailService.sendShiftAlert(
                                            companyConfig.adminEmail,
                                            user,
                                            "FORCE_OUT",
                                            shift.end,
                                            shift.location || "-",
                                            companyConfig.businessName || client.id,
                                            `המשמרת נסגרה אוטומטית כי חרגה מהמגבלה של ${maxHours} שעות.`,
                                            companyConfig.logoUrl
                                        ).catch(e => console.error(`[Auto-Checkout Email FAIL] ${e.message}`));
                                    }
                                }
                                // CASE 2: Auto Checkout NOT enforced, but Alert IS enabled -> Send ALERT_MAX (Once)
                                else if (enableAlert && !shift.maxAlertSent) {
                                    shift.maxAlertSent = true; // Mark to prevent spamming on next interval
                                    changed = true;

                                    if (companyConfig.adminEmail) {
                                        emailService.sendShiftAlert(
                                            companyConfig.adminEmail,
                                            user,
                                            "ALERT_MAX",
                                            now.getTime(),
                                            shift.location || "-",
                                            companyConfig.businessName || client.id,
                                            `העובד נמצא במשמרת פעילה מעל ${maxHours} שעות (נוכחי: ${durationHours.toFixed(1)} שעות).`,
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
            }
        }
        return results;
    }

    async extendSubscription(companyId, planId, price) {
        const client = await this.getClientById(companyId);
        if (!client) throw new Error("Company not found");

        const systemConfig = await this.getSystemConfig();
        // Plans are stored under tranzilaPlans key in system_config.json
        const plan = (systemConfig.tranzilaPlans || systemConfig.plans)?.find(p => String(p.id) === String(planId));
        if (!plan) throw new Error(`Plan not found: id=${planId}. Available plans: ${JSON.stringify((systemConfig.tranzilaPlans || systemConfig.plans || []).map(p => p.id))}`);

        const monthsToAdd = plan.months || 1;
        const now = new Date();
        let currentExpiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : now;

        // Alignment Logic (1st of the month)
        // If expired, start adding from the next month's 1st.
        // If active, add to the current expiry date base.

        let targetDate;
        if (currentExpiry < now) {
            // Expired: Start from the 1st of the next month
            targetDate = new Date();
            targetDate.setMonth(targetDate.getMonth() + 1);
            targetDate.setDate(1);
        } else {
            // Active: Just use current expiry as base
            targetDate = new Date(currentExpiry);
        }

        // Add the months from the plan
        targetDate.setMonth(targetDate.getMonth() + monthsToAdd);

        // Ensure it's exactly the 1st day (consistent alignment)
        targetDate.setDate(1);
        targetDate.setHours(23, 59, 59, 999);

        client.subscriptionExpiry = targetDate.toISOString();

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

                    const bizConfig = await this.getBusinessConfig(client.id);
                    emailService.sendSubscriptionAlert(
                        client.email,
                        client.businessName,
                        daysLeft,
                        client.subscriptionExpiry,
                        bizConfig.logoUrl
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

    async runGlobalArchiveCycle() {
        console.log(`[DataManager] Global Archive Cycle Triggered at ${new Date().toISOString()}`);
        for (const client of CACHE.clients) {
            try {
                const res = await this.archiveAndCleanup(client.id);
                if (res.archived > 0) {
                    console.log(`[DataManager] Cleaned up ${res.archived} months for ${client.id}`);
                }
                // Also check subscriptions
                await this.checkSubscriptions();
            } catch (err) {
                console.error(`[DataManager] Cleanup failed for ${client.id}:`, err.message);
            }
        }
    }
    // --- GEOLOCATION HELPERS ---

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371e3; // metres
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const Δφ = (lat2 - lat1) * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c; // in metres
    }

    isPointInPolygon(lat, lng, polygon) {
        if (!polygon || polygon.length < 3) return false;
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].lat, yi = polygon[i].lng;
            const xj = polygon[j].lat, yj = polygon[j].lng;
            const intersect = ((yi > lng) !== (yj > lng)) && (lat < (xj - xi) * (lng - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    calculateDistanceToPolygon(lat, lng, polygon) {
        if (!polygon || polygon.length < 3) return 0;

        // If inside, distance is 0
        if (this.isPointInPolygon(lat, lng, polygon)) return 0;

        let minMeters = Infinity;
        const p = { lat, lng };

        for (let i = 0; i < polygon.length; i++) {
            const v = polygon[i];
            const w = polygon[(i + 1) % polygon.length];

            // Nearest projection on segment
            const l2 = (v.lat - w.lat) ** 2 + (v.lng - w.lng) ** 2;
            let t = 0;
            if (l2 > 0) {
                t = ((p.lat - v.lat) * (w.lat - v.lat) + (p.lng - v.lng) * (w.lng - v.lng)) / l2;
                t = Math.max(0, Math.min(1, t));
            }

            const projLat = v.lat + t * (w.lat - v.lat);
            const projLng = v.lng + t * (w.lng - v.lng);

            const d = this.calculateDistance(lat, lng, projLat, projLng);
            if (d < minMeters) minMeters = d;
        }
        return minMeters;
    }
}


const manager = new DataManager();

// --- AUTO-ARCHIVE TRIGGER (Once every 24 hours) ---
// This runs the global archive cycle for all companies
setTimeout(() => {
    manager.runGlobalArchiveCycle().catch(err => {
        console.error('[DataManager] Auto-Archive Initial Error:', err.message);
    });
}, 1000 * 60 * 5); // Start 5 mins after boot

setInterval(() => {
    manager.runGlobalArchiveCycle().catch(err => {
        console.error('[DataManager] Auto-Archive Interval Error:', err.message);
    });
}, 24 * 60 * 60 * 1000);

module.exports = manager;
