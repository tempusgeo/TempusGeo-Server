const axios = require('axios');
const config = require('../config');

class TranzilaService {

    // Validate Transaction (Server-to-Server)
    async verifyTransaction(params) {
        // params: { sum, currency, ccno, expmonth, expyear, myid, cred_type, ... }

        // Add Terminal Credentials (Server Side Only)
        // In production, use environment variables!
        // 1a. Unify Expiry Date (Tranzila expects expdate in MMYY)
        const mm = String(params.expmonth || '').padStart(2, '0');
        const yy = String(params.expyear || '').slice(-2);
        const expdate = mm + yy;

        // Add Terminal Credentials (Server Side Only)
        // In production, use environment variables!
        const payload = {
            ...params,
            supplier: params.supplier || config.TRANZILA_TERMINAL_NAME,
            tranmode: params.tranmode || "A", // Verification Only (J5) or M/A (Charge)
            expdate: expdate,
            TranzilaPW: params.TranzilaPW || config.TRANZILA_TERMINAL_PASS
        };
        
        // Remove individual fields after unifying
        delete payload.expmonth;
        delete payload.expyear;

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
        
        // 1a. Unify Expiry Date (Tranzila expects expdate in MMYY)
        const mm = String(params.expmonth || '').padStart(2, '0');
        const yy = String(params.expyear || '').slice(-2);
        const expdate = mm + yy;

        const payload = {
            ...params,
            supplier: params.supplier || config.TRANZILA_TERMINAL_NAME,
            tranmode: params.tranmode || "A", // A = Normal auth with token. F (Force) blocked by acquirer.
            expdate: expdate,
            TranzilaPW: params.TranzilaPW || config.TRANZILA_TERMINAL_PASS
        };

        // Remove individual fields
        delete payload.expmonth;
        delete payload.expyear;

        try {
            console.log(`[Tranzila] Charging token for amount: ${params.sum}, tranmode: ${payload.tranmode}`);
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

    /**
     * Refund/cancel a Tranzila transaction using tranmode=C{index}
     * Requires refundPass (tranzilaRefundPass) - different from the charge password.
     */
    async refundTransaction({ supplier, refundPass, tranzilaIndex, sum }) {
        if (!supplier || !refundPass || !tranzilaIndex || !sum) {
            return { success: false, error: 'Missing required refund parameters (supplier, refundPass, tranzilaIndex, sum)' };
        }

        const payload = {
            supplier,
            TranzilaPW: refundPass,
            tranmode: `C${tranzilaIndex}`,
            sum: sum 
        };

        try {
            console.log(`[Tranzila] Refunding transaction index: ${tranzilaIndex}`);
            const response = await axios.post(config.TRANZILA.API_URL, new URLSearchParams(payload).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const responseBody = response.data;
            const parsed = new URLSearchParams(responseBody);
            const responseCode = parsed.get('Response');

            console.log(`[Tranzila] Refund response: ${responseCode} | raw: ${responseBody.slice(0, 200)}`);

            return {
                success: responseCode === '000',
                responseCode,
                raw: responseBody,
                data: Object.fromEntries(parsed)
            };
        } catch (e) {
            console.error('[Tranzila] Refund Error:', e.message);
            return { success: false, error: e.message };
        }
    }
}

module.exports = new TranzilaService();

