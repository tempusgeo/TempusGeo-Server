const dataManager = require('./DataManager');
const uuid = require('uuid');

class AuthService {

    // Admin Login (Company Owner)
    // Returns { success: true, token: '...', config: ... }
    async adminLogin(identifier, password) {
        // Use the public method to get all clients safely
        const allClients = await dataManager.getAllClients();

        // Find by ID or email, with matching password
        const client = allClients.find(c =>
            (c.id === identifier || c.email === identifier) && c.password === password
        );

        if (!client) {
            return { success: false, error: "תעודת זהות או סיסמה שגויה" };
        }

        // Check Subscription Expiry
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

    async forgotAdminPassword(companyId) {
        // Lazy require to avoid any module initialization order issues
        const emailService = require('./EmailService');

        const client = await dataManager.getClientById(companyId);
        if (!client) return { success: false, error: "Company not found" };

        if (!client.email) return { success: false, error: "No email associated with this account" };

        const newPass = Math.random().toString(36).slice(-8);
        client.password = newPass;
        await dataManager.saveClients();

        if (typeof emailService.sendRecoveryEmail !== 'function') {
            console.error('[AuthService] emailService.sendRecoveryEmail not available:', typeof emailService);
            return { success: false, error: "Email service unavailable" };
        }

        const emailResult = await emailService.sendRecoveryEmail(client.email, newPass);

        if (emailResult.success) {
            return { success: true, message: "New password sent to email" };
        } else {
            return { success: false, error: "Failed to send email: " + (emailResult.error || '') };
        }
    }
}

module.exports = new AuthService();
