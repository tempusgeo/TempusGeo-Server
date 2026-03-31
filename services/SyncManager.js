const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;

/**
 * SyncManager
 * Handles background synchronization between Render and GAS.
 * Ensures "Eventual Consistency" by queuing actions and retrying on failure.
 */
class SyncManager {
    constructor() {
        this.queue = [];
        this.isProcessing = false;
        this.maxRetries = 5;
        this.retryDelay = 5000; // 5 seconds initial delay
    }

    /**
     * Enqueue a sync action
     * @param {string} type - 'SHIFT' | 'CONFIG' | 'METADATA'
     * @param {Object} payload - The data to sync
     * @param {Object} options - { companyId, gasUrl, password }
     */
    enqueue(type, payload, options) {
        this.queue.push({
            type,
            payload,
            options,
            retries: 0,
            addedAt: Date.now()
        });

        console.log(`[SyncManager] Enqueued ${type} for ${options.companyId}. Queue size: ${this.queue.length}`);
        
        // Start processing if not already running
        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    /**
     * Perform sync immediately and wait for result
     */
    async syncNow(type, payload, options) {
        console.log(`[SyncManager] Performing immediate sync for ${type} (${options.companyId})`);
        return await this.performSync({ type, payload, options });
    }

    async processQueue() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;
        const item = this.queue[0];

        try {
            await this.performSync(item);
            // Success! Remove from queue and move to next
            this.queue.shift();
            console.log(`[SyncManager] Successfully synced ${item.type} for ${item.options.companyId}`);
            this.processQueue();
        } catch (error) {
            item.retries++;
            console.error(`[SyncManager] Sync failed for ${item.type} (${item.options.companyId}). Retries: ${item.retries}/${this.maxRetries}. Error: ${error.message}`);

            if (item.retries >= this.maxRetries) {
                console.error(`[SyncManager] ${item.type} failed after maximum retries. Dropping item.`);
                this.queue.shift();
                this.processQueue();
            } else {
                // Retry after delay
                setTimeout(() => this.processQueue(), this.retryDelay * item.retries);
            }
        }
    }

    async performSync(item) {
        const { type, payload, options } = item;
        const { gasUrl, companyId, password } = options;

        if (!gasUrl) throw new Error('Missing GAS URL');

        let action = '';
        const postData = { companyId, password };

        switch (type) {
            case 'SHIFT':
                action = 'archiveMonth';
                postData.action = action;
                postData.year = payload.year;
                postData.month = payload.month;
                postData.data = JSON.stringify(payload.shifts);
                break;
            
            case 'CONFIG':
                postData.action = 'archive';
                postData.companyId = options.companyId || '__SYSTEM_CONFIG__';
                postData.year = 'config'; 
                postData.month = 'json';  
                postData.data = JSON.stringify(payload);
                break;

            case 'CLIENTS':
                postData.action = 'archive';
                postData.companyId = options.companyId || '__SYSTEM_CLIENTS__';
                postData.year = 'clients';
                postData.month = 'json';
                postData.data = JSON.stringify(payload);
                break;

            case 'LEDGER':
                postData.action = 'archive';
                postData.year = 'ledger';
                postData.month = 'json';
                postData.data = JSON.stringify(payload.ledger);
                break;

            default:
                throw new Error(`Unknown sync type: ${type}`);
        }

        const response = await axios.post(gasUrl, postData, { timeout: 30000 });
        if (!response.data || !response.data.success) {
            throw new Error(response.data?.error || 'GAS returned failure');
        }
    }
}

module.exports = new SyncManager();
