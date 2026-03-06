const axios = require('axios');
const config = require('../config');

class TranzilaService {

    // Validate Transaction (Server-to-Server)
    async verifyTransaction(params) {
        // params: { sum, currency, ccno, expmonth, expyear, myid, cred_type, ... }

        // Add Terminal Credentials (Server Side Only)
        // In production, use environment variables!
        const payload = {
            ...params,
            supplier: process.env.TRANZILA_TERMINAL_NAME || "test",
            tranmode: "A", // Verification Only (J5) or M (Charge)
            TranzilaPW: process.env.TRANZILA_TERMINAL_PASS || "test"
        };

        try {
            console.log("Sending request to Tranzila...");
            const response = await axios.post(config.TRANZILA.API_URL, new URLSearchParams(payload).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            // Tranzila returns a query string like "Response=000&myid=123..."
            // We need to parse it.
            const responseBody = response.data;
            const parsed = new URLSearchParams(responseBody);

            return {
                success: parsed.get('Response') === '000',
                raw: responseBody,
                data: Object.fromEntries(parsed)
            };

        } catch (e) {
            console.error("Tranzila Error:", e.message);
            return { success: false, error: e.message };
        }
    }

    async processPaymentProxy(payload) {
        // Payload from Client: { transactionId, sum, ... } or full card details to be sent to PHP
        // unexpected payload? The PHP script expects specific fields.
        // We just forward whatever the client sent, adding any potential server-side secrets if needed (though PHP should handle secrets).

        try {
            console.log("Proxying payment to JetServer...", config.JETSERVER_PAYMENT_URL);
            const response = await axios.post(config.JETSERVER_PAYMENT_URL, payload);
            return response.data;
        } catch (e) {
            console.error("JetServer Proxy Error:", e.message);
            return { success: false, error: "Payment Gateway Error" };
        }
    }
}

module.exports = new TranzilaService();
