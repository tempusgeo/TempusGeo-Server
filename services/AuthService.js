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
        const expiry = new Date(client.subscriptionExpiry);
        const isExpired = expiry < now;

        const config = await dataManager.getCompanyConfig(client.id);

        return {
            success: true,
            companyId: client.id,
            config: config,
            settings: config.settings || {},
            paymentHistory: client.paymentHistory || (client.lastPayment ? [client.lastPayment] : []),
            isExpired: isExpired,
            expiryDate: client.subscriptionExpiry,
            role: 'admin'
        };
    }

    async changeAdminPassword(companyId, oldPassword, newPassword) {
        const client = await dataManager.getClientById(companyId);
        if (!client) return { success: false, error: "Company not found" };

        if (client.password !== oldPassword) {
            return { success: false, error: "Old password incorrect" };
        }

        client.password = newPassword;
        await dataManager.saveClients();

        return { success: true, message: "Password updated successfully" };
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
