const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const stateFilePath = path.join(dataDir, 'maintenance_state.json');
const whitelistPath = path.join(__dirname, 'maintewhitelist.json');

// Ensure the 'data' directory exists
if (!fs.existsSync(dataDir)) {
    try {
        fs.mkdirSync(dataDir, { recursive: true });
    } catch (error) {
        console.error('❌ Failed to create data directory:', error);
    }
}

// Helper function to read the saved maintenance state from the JSON file
function loadMaintenanceState() {
    try {
        if (!fs.existsSync(stateFilePath)) {
            return false; // Default to false if no state file exists yet
        }
        const data = fs.readFileSync(stateFilePath, 'utf8');
        const parsed = JSON.parse(data);
        return typeof parsed.isMaintenanceMode === 'boolean' ? parsed.isMaintenanceMode : false;
    } catch (error) {
        console.error('❌ Failed to read maintenance_state.json:', error);
        return false;
    }
}

// Helper function to save the maintenance state to the JSON file
function saveMaintenanceState(status) {
    try {
        const payload = JSON.stringify({ isMaintenanceMode: status }, null, 2);
        fs.writeFileSync(stateFilePath, payload, 'utf8');
    } catch (error) {
        console.error('❌ Failed to write maintenance_state.json:', error);
    }
}

// Initialize state from file on startup
let isMaintenanceMode = loadMaintenanceState();

// Helper function to read whitelisted servers from the JSON file
function getWhitelistedGuilds() {
    try {
        if (!fs.existsSync(whitelistPath)) {
            return [];
        }
        const data = fs.readFileSync(whitelistPath, 'utf8');
        const parsed = JSON.parse(data);
        return Array.isArray(parsed.whitelistedGuilds) ? parsed.whitelistedGuilds : [];
    } catch (error) {
        console.error('❌ Failed to read maintewhitelist.json:', error);
        return [];
    }
}

module.exports = {
    // Pass guildId (optional) to check if a specific server is allowed during maintenance
    isMaintenance: (guildId = null) => {
        if (!isMaintenanceMode) return false; // If maintenance is off, nobody is blocked

        // If maintenance is on, check if this specific guild is whitelisted
        if (guildId) {
            const whitelisted = getWhitelistedGuilds();
            if (whitelisted.includes(guildId)) {
                return false; // Whitelisted! Treat as NOT in maintenance.
            }
        }

        return true; // Under maintenance and not whitelisted
    },

    toggleMaintenance: (status) => {
        isMaintenanceMode = status !== undefined ? status : !isMaintenanceMode;
        saveMaintenanceState(isMaintenanceMode); // Persist state change to file
        return isMaintenanceMode;
    }
};