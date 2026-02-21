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
      const expiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : new Date(0);
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
    if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

    const cacheKey = `${year}-${month}`;
    if (CACHE.companies[companyId].shifts[cacheKey]) {
      return CACHE.companies[companyId].shifts[cacheKey];
    }

    // Load from Disk
    const companyDir = path.join(this.dataDir, 'companies', companyId);
    const yearDir = path.join(companyDir, year.toString());
    const fileName = `${month}.json`;
    const filePath = path.join(yearDir, fileName);

    let shifts = {};
    try {
      const data = await fs.readFile(filePath, 'utf8');
      shifts = JSON.parse(data);
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
    const filePath = path.join(yearDir, `${month}.json`);
    await fs.writeFile(filePath, JSON.stringify(shiftsData, null, 2));
    await this.updateLastWriteTime();
  }

  async getEmployeeStatus(companyId, employeeName) {
    if (!CACHE.companies[companyId]) await this.loadCompany(companyId);

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const shifts = await this.getShifts(companyId, year, month);

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
    await this.getShifts(companyId, year, month);

    const currentShifts = CACHE.companies[companyId].shifts[`${year}-${month}`] || {};
    return Object.keys(currentShifts).sort();
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
        if (note) lastShift.note = note;
      } else {
        shifts[employeeName].push({ start: null, end: timestamp, note: "Manual Out without In" });
      }
    }

    await this.saveShifts(companyId, year, month, shifts);

    // --- EMAIL NOTIFICATION ---
    try {
      const companyConfig = await this.getCompanyConfig(companyId);
      if (companyConfig.settings && companyConfig.settings.emailOnShiftChange && companyConfig.adminEmail) {
        emailService.sendShiftAlert(
          companyConfig.adminEmail, employeeName, action, timestamp, location, companyConfig.businessName
        ).catch(e => console.error(`[Email Alert] Failed to send shift alert: ${e.message}`));
      }
    } catch (e) {
      console.error(`[Email Alert] Error checking config: ${e.message}`);
    }

    return { success: true };
  }

  async getDashboard(companyId) {
    if (!CACHE.companies[companyId]) await this.loadCompany(companyId);
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const shifts = await this.getShifts(companyId, year, month);
    const employees = await this.getEmployees(companyId);

    const dashboard = [];
    for (const emp of employees) {
      const empShifts = shifts[emp] || [];
      const lastShift = empShifts[empShifts.length - 1];

      let dailyTotal = 0;
      const todayStr = now.toDateString();
      empShifts.forEach(s => {
        const sDate = new Date(s.start || s.end);
        if (sDate.toDateString() === todayStr) {
          if (s.end && s.start) {
            dailyTotal += (new Date(s.end) - new Date(s.start)) / 3600000;
          } else if (s.start && !s.end) {
            dailyTotal += (now - new Date(s.start)) / 3600000;
          }
        }
      });

      dashboard.push({
        name: emp,
        status: (lastShift && !lastShift.end) ? 'IN' : 'OUT',
        time: (lastShift && !lastShift.end) ? lastShift.start : (lastShift ? lastShift.end : null),
        duration: dailyTotal.toFixed(2),
        weekly: '0.00'
      });
    }
    return dashboard;
  }

  async getHistoryYears(companyId) {
    const companyDir = path.join(this.dataDir, 'companies', companyId);
    const years = new Set();
    try {
      const files = await fs.readdir(companyDir);
      for (const file of files) {
        if (file === 'config.json') continue;
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

  async adminSaveShift(companyId, { year, month, name, originalStart, newStart, newEnd }) {
    const shifts = await this.getShifts(companyId, parseInt(year), parseInt(month));
    if (!shifts[name]) return;

    const shiftIndex = shifts[name].findIndex(s => s.start === originalStart || (new Date(s.start).getTime() === new Date(originalStart).getTime()));
    if (shiftIndex !== -1) {
      shifts[name][shiftIndex].start = newStart;
      shifts[name][shiftIndex].end = newEnd;
      await this.saveShifts(companyId, parseInt(year), parseInt(month), shifts);
    } else if (!originalStart) {
      shifts[name].push({ start: newStart, end: newEnd, location: 'Admin Add' });
      await this.saveShifts(companyId, parseInt(year), parseInt(month), shifts);
    }
  }

  async adminDeleteShift(companyId, { year, month, name, start }) {
    const shifts = await this.getShifts(companyId, parseInt(year), parseInt(month));
    if (!shifts[name]) return;

    shifts[name] = shifts[name].filter(s => s.start !== start && new Date(s.start).getTime() !== new Date(start).getTime());
    await this.saveShifts(companyId, parseInt(year), parseInt(month), shifts);
  }

  async adminForceAction(companyId, { name, forceType }) {
    await this.logShift(companyId, name, forceType === 'checkIn' ? 'IN' : 'OUT', Date.now(), 'Admin Force', 'Forced by Admin');
  }

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

  isHotMonth(year, month) {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    if (year === currentYear && month === currentMonth) return true;
    const lastMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const lastMonthYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    return year === lastMonthYear && month === lastMonth;
  }

  async cleanupOldMonths() {
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
              await fs.unlink(path.join(yearDir, monthFile));
              const cacheKey = `${year}-${month}`;
              if (CACHE.companies[companyId]?.shifts[cacheKey]) {
                delete CACHE.companies[companyId].shifts[cacheKey];
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[Cleanup] Error during cleanup:', e);
    }
  }

  async getBackupData() {
    const backup = { 
      timestamp: new Date().toISOString(), 
      lastWriteTime: await this.getLastWriteTime(), 
      clients: CACHE.clients, 
      companies: {} 
    };
    for (const [companyId, data] of Object.entries(CACHE.companies)) {
      backup.companies[companyId] = { config: data.config, shifts: data.shifts };
    }
    return backup;
  }

  async fetchColdData(companyId, year, month) {
    const cacheKey = `${year}-${month}`;
    const companyCache = CACHE.historicalData[companyId] || {};
    if (companyCache[cacheKey]) {
      const cached = companyCache[cacheKey];
      if (Date.now() - cached.timestamp < 3600000) return cached.data;
    }
    try {
      const gasUrl = config.GAS_COLD_STORAGE_URL;
      if (!gasUrl) return {};
      const response = await axios.get(`${gasUrl}/history/${companyId}/${year}/${month}`, { timeout: 5000 });
      if (!CACHE.historicalData[companyId]) CACHE.historicalData[companyId] = {};
      CACHE.historicalData[companyId][cacheKey] = { data: response.data, timestamp: Date.now() };
      return response.data;
    } catch (e) {
      return {};
    }
  }

  async getShiftsHybrid(companyId, year, month) {
    return this.isHotMonth(year, month) ? this.getShifts(companyId, year, month) : this.fetchColdData(companyId, year, month);
  }

  async smartRestoreFromGAS(localTime) {
    try {
      const gasUrl = config.GAS_COLD_STORAGE_URL;
      if (!gasUrl) return false;
      const response = await axios.get(`${gasUrl}?path=restore`, { timeout: 30000 });
      if (!response.data || !response.data.success) return false;

      const backup = response.data.data;
      const remoteTime = backup.metadata ? backup.metadata.lastWriteTime : 0;

      if (localTime > 0 && localTime >= remoteTime) return true;

      if (backup.clients) {
        CACHE.clients = backup.clients;
        await fs.writeFile(this.clientsFile, JSON.stringify(CACHE.clients, null, 2));
      }

      for (const [companyId, companyData] of Object.entries(backup.companies)) {
        const companyDir = path.join(this.dataDir, 'companies', companyId);
        await fs.mkdir(companyDir, { recursive: true });
        if (companyData.config) {
          await fs.writeFile(path.join(companyDir, 'config.json'), JSON.stringify(companyData.config, null, 2));
          if (!CACHE.companies[companyId]) CACHE.companies[companyId] = { config: {}, shifts: {} };
          CACHE.companies[companyId].config = companyData.config;
        }
        if (companyData.shifts) {
          for (const [key, shifts] of Object.entries(companyData.shifts)) {
            const [year, month] = key.split('-');
            const yearDir = path.join(companyDir, year);
            await fs.mkdir(yearDir, { recursive: true });
            await fs.writeFile(path.join(yearDir, `${month}.json`), JSON.stringify(shifts, null, 2));
            CACHE.companies[companyId].shifts[key] = shifts;
          }
        }
      }

      if (remoteTime > 0) await fs.writeFile(this.metadataFile, JSON.stringify({ lastWriteTime: remoteTime }));
      return true;
    } catch (e) {
      return false;
    }
  }

  async getFullHistoryForExport(companyId) {
    const companyDir = path.join(this.dataDir, 'companies', companyId);
    const filePaths = [];
    try {
      const years = await fs.readdir(companyDir);
      for (const year of years) {
        if (year === 'config.json') continue;
        const yearDir = path.join(companyDir, year);
        const months = await fs.readdir(yearDir);
        for (const month of months) {
          filePaths.push({ name: `${year}_${month}`, path: path.join(yearDir, month) });
        }
      }
    } catch (e) { }
    return filePaths;
  }

  async createBusiness(data) {
    let newId;
    do {
      newId = Math.floor(1000 + Math.random() * 9000).toString();
    } while (CACHE.companies[newId] || CACHE.clients.find(c => c.id === newId));

    const client = {
      id: newId,
      businessName: data.businessName,
      email: data.email,
      phone: data.phone,
      password: data.password,
      subscriptionExpiry: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
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

  async performAutoCheckout() {
    const now = new Date();
    const results = { checked: 0, closed: 0, errors: [] };
    for (const client of CACHE.clients) {
      try {
        results.checked++;
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const shiftsData = await this.getShifts(client.id, year, month);
        let changed = false;
        for (const [user, shifts] of Object.entries(shiftsData)) {
          for (const shift of shifts) {
            if (!shift.end && shift.start) {
              const startTime = new Date(shift.start);
              if ((now - startTime) / 3600000 > 12) {
                shift.end = new Date(startTime.getTime() + 12 * 3600000).toISOString();
                shift.note = (shift.note || "") + " [Auto-Checkout: 12h limit]";
                changed = true;
                results.closed++;
              }
            }
          }
        }
        if (changed) await this.saveShifts(client.id, year, month, shiftsData);
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
    if (currentExpiry < now) currentExpiry = now;
    currentExpiry.setMonth(currentExpiry.getMonth() + monthsToAdd);
    client.subscriptionExpiry = currentExpiry.toISOString();

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
        if (daysLeft <= 3) {
          results.expired++;
          emailService.sendSubscriptionAlert(client.email, client.businessName, daysLeft, client.subscriptionExpiry).catch(console.error);
        } else {
          results.valid++;
        }
      }
    }
    return results;
  }
}

module.exports = new DataManager();
