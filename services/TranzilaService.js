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
            supplier: params.supplier || config.TRANZILA_TERMINAL_NAME,
            tranmode: "A", // Verification Only (J5) or M (Charge)
            TranzilaPW: params.TranzilaPW || config.TRANZILA_TERMINAL_PASS
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
        // The PHP script expects specific fields and a security token.

        try {
            const secureToken = config.JETSERVER_TOKEN || 'tempusgeo_proxy_9988_secure';
            console.log("Proxying payment to JetServer...", config.JETSERVER_PAYMENT_URL);
            const response = await axios.post(config.JETSERVER_PAYMENT_URL, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-jetserver-token': secureToken
                }
            });
            return response.data;
        } catch (e) {
            console.error("JetServer Proxy Error:", e.message);
            return { success: false, error: "Payment Gateway Error" };
        }
    }

    async chargeToken(params) {
        // params: { sum, currency, TranzilaToken, expmonth, expyear, myid, ... }
        
        const payload = {
            ...params,
            supplier: params.supplier || config.TRANZILA_TERMINAL_NAME,
            tranmode: "M", // M = Charge
            TranzilaPW: params.TranzilaPW || config.TRANZILA_TERMINAL_PASS
        };

        try {
            console.log(`[Tranzila] Charging token for amount: ${params.sum}`);
            const response = await axios.post(config.TRANZILA.API_URL, new URLSearchParams(payload).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const responseBody = response.data;
            const parsed = new URLSearchParams(responseBody);

            return {
                success: parsed.get('Response') === '000',
                raw: responseBody,
                data: Object.fromEntries(parsed),
                confirmationCode: parsed.get('ConfirmationCode'),
                index: parsed.get('index')
            };

        } catch (e) {
            console.error("[Tranzila] Charge Token Error:", e.message);
            return { success: false, error: e.message };
        }
    }
}

module.exports = new TranzilaService();
