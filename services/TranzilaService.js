const axios = require('axios');
const config = require('../config');

class TranzilaService {

    // Validate Transaction (Server-to-Server)
    async verifyTransaction(params) {
        const mm = String(params.expmonth || '').padStart(2, '0');
        const yy = String(params.expyear || '').slice(-2);
        const expdate = mm + yy;

        const payload = {
            ...params,
            supplier: params.supplier || config.TRANZILA_TERMINAL_NAME,
            tranmode: params.tranmode || "A",
            expdate: expdate,
            TranzilaPW: params.TranzilaPW || config.TRANZILA_TERMINAL_PASS
        };
        
        delete payload.expmonth;
        delete payload.expyear;

        try {
            console.log("Sending request to Tranzila...");
            const response = await axios.post(config.TRANZILA.API_URL, new URLSearchParams(payload).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            const parsed = new URLSearchParams(response.data);
            return {
                success: parsed.get('Response') === '000',
                raw: response.data,
                data: Object.fromEntries(parsed)
            };
        } catch (e) {
            console.error("Tranzila Error:", e.message);
            return { success: false, error: e.message };
        }
    }

    async processPaymentProxy(payload) {
        try {
            const secureToken = config.JETSERVER_TOKEN || 'tempusgeo_proxy_9988_secure';
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
        const mm = String(params.expmonth || '').padStart(2, '0');
        const yy = String(params.expyear || '').slice(-2);
        const expdate = mm + yy;

        // Ensure we use 'TranzilaToken' as the standard key for tranzila71u.cgi
        const token = params.TranzilaToken || params.TranzilaTK || params.token;

        const payload = {
            ...params,
            supplier: params.supplier || config.TRANZILA_TERMINAL_NAME,
            TranzilaPW: params.TranzilaPW || config.TRANZILA_TERMINAL_PASS,
            TranzilaToken: token,
            tranmode: params.tranmode || "A", 
            expdate: expdate
        };

        delete payload.expmonth;
        delete payload.expyear;
        delete payload.TranzilaTK;
        delete payload.token;

        try {
            console.log(`[Tranzila] Charging token for amount: ${params.sum}`);
            const response = await axios.post(config.TRANZILA.API_URL, new URLSearchParams(payload).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const parsed = new URLSearchParams(response.data);
            return {
                success: parsed.get('Response') === '000',
                raw: response.data,
                data: Object.fromEntries(parsed),
                confirmationCode: parsed.get('ConfirmationCode'),
                index: parsed.get('index')
            };
        } catch (e) {
            console.error("[Tranzila] Charge Token Error:", e.message);
            return { success: false, error: e.message };
        }
    }

    async refundTransaction(params) {
        // params: { sum, index, authCode, TranzilaPW }
        const payload = {
            supplier: config.TRANZILA_TERMINAL_NAME,
            tranmode: 'C', // Credit/Refund
            sum: params.sum,
            TranzilaPW: params.TranzilaPW || config.TRANZILA_TERMINAL_PASS,
            index: params.index,
            authcode: params.authCode
        };

        try {
            console.log(`[Tranzila] Refunding transaction index: ${params.index}, sum: ${params.sum}`);
            const response = await axios.post(config.TRANZILA.API_URL, new URLSearchParams(payload).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            const parsed = new URLSearchParams(response.data);
            return {
                success: parsed.get('Response') === '000',
                raw: response.data,
                data: Object.fromEntries(parsed)
            };
        } catch (e) {
            console.error("[Tranzila] Refund Error:", e.message);
            return { success: false, error: e.message };
        }
    }

    async voidTransaction(params) {
        // params: { index, TranzilaPW }
        const payload = {
            supplier: config.TRANZILA_TERMINAL_NAME,
            tranmode: 'V', // Void (Same day cancellation)
            TranzilaPW: params.TranzilaPW || config.TRANZILA_TERMINAL_PASS,
            index: params.index
        };

        try {
            console.log(`[Tranzila] Voiding transaction index: ${params.index}`);
            const response = await axios.post(config.TRANZILA.API_URL, new URLSearchParams(payload).toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });
            const parsed = new URLSearchParams(response.data);
            return {
                success: parsed.get('Response') === '000',
                raw: response.data,
                data: Object.fromEntries(parsed)
            };
        } catch (e) {
            console.error("[Tranzila] Void Error:", e.message);
            return { success: false, error: e.message };
        }
    }
}

module.exports = new TranzilaService();
