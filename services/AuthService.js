const dataManager = require('./DataManager');

class AuthService {

    async adminLogin(identifier, password) {
        const allClients = await dataManager.getAllClients();

        const client = allClients.find(c =>
            (c.id === identifier || c.email === identifier) && c.password === password
        );

        if (!client) {
            return { success: false, error: "תעודת זהות או סיסמה שגויה" };
        }

        const now = new Date();
        const expiry = client.subscriptionExpiry ? new Date(client.subscriptionExpiry) : null;
        let isExpired = false;
        
        if (expiry) {
            // Precise comparison: expiry must be strictly in the future
            isExpired = expiry.getTime() <= now.getTime();
        }


        const config = await dataManager.getCompanyConfig(client.id);

        const activeEmployees = await dataManager.countUniqueActiveEmployees(client.id);
        const subRes = await dataManager.calculateSubscriptionAmount(client.id);
        const expectedPayment = subRes.amount;

        return {
            success: true,
            companyId: client.id,
            config: config,
            settings: config.settings || {},
            paymentHistory: client.paymentHistory || (client.lastPayment ? [client.lastPayment] : []),
            paymentMethod: client.paymentMethod || null,
            autoChargeEnabled: client.autoChargeEnabled || false,
            activeEmployees: activeEmployees,
            expectedPayment: expectedPayment,
            isExpired: isExpired,
            expiryDate: client.subscriptionExpiry,
            isFreeTrial: !!client.isFreeTrial, // Added
            role: 'admin'
        };
    }

    async changeAdminPassword(companyId, oldPassword, newPassword) {
        const client = await dataManager.getClientById(companyId);
        if (!client) return { success: false, error: "Company not found" };

        // No old password check needed — user is already authenticated as admin
        client.password = newPassword;
        await dataManager.saveClients();

        return { success: true, message: "הסיסמה שונתה בהצלחה" };
    }

    // emailService is injected from api.js to avoid any circular require issue.
    // api.js is always the one that loads EmailService last (after all deps), so it's safe.
    async forgotAdminPassword(companyId, emailService) {
        const client = await dataManager.getClientById(companyId);
        if (!client) return { success: false, error: "Company not found" };
        if (!client.email) return { success: false, error: "No email associated with this account" };

        const newPass = Math.random().toString(36).slice(-8);
        client.password = newPass;
        await dataManager.saveClients();

        // NON-BLOCKING: queue email - EmailService worker handles GAS call in background with retries
        emailService.sendRecoveryEmail(client.email, newPass);

        return { success: true, message: "New password sent to email" };
    }
}

module.exports = new AuthService();
