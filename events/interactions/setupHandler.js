const { MessageFlags } = require('discord.js');
const db = require('../../utils/db');
const fs = require('fs');
const path = require('path');
const { isMaintenance } = require('../../maintenance');
const { t } = require('../../utils/i18n');
const userLanguage = require('../../utils/userLanguage');

// Adjusted path to point directly to the project root directory where package.json and google-credentials.json reside
const CREDENTIALS_PATH = path.join(__dirname, '..', '..', 'google-credentials.json');

/**
 * Extracts a Google Spreadsheet ID from a URL or raw ID string.
 */
function extractSpreadsheetId(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    
    const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (match && match[1]) {
        return match[1];
    }
    
    if (/^[a-zA-Z0-9-_]{20,}$/.test(trimmed)) {
        return trimmed;
    }
    
    return null;
}

/**
 * Returns the Google service account email from credentials if available.
 */
function getServiceAccountEmail() {
    try {
        if (fs.existsSync(CREDENTIALS_PATH)) {
            const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
            return creds.client_email || 'google-credentials.json missing client_email';
        }
    } catch (e) {
        // fallback
    }
    return 'google-credentials.json missing client_email';
}

async function handleModal(interaction) {
    if (!interaction.isModalSubmit()) return;
    const lang = await userLanguage.forInteraction(interaction);

    // Maintenance Check: Block interaction when maintenance mode is ON (allows whitelisted servers to bypass)
    if (isMaintenance(interaction.guildId)) {
        return interaction.reply({
            content: t(lang, 'core.maintenance'),
            flags: [MessageFlags.Ephemeral]
        });
    }
    
    const customId = interaction.customId;
    if (customId !== 'raid_setup_modal' && customId !== 'logger_setup_modal') return;

    const guildId = interaction.guildId;
    const inputId = customId === 'raid_setup_modal' ? 'sheet_url_input' : 'logger_url_input';
    const rawUrl = interaction.fields.getTextInputValue(inputId);
    const spreadsheetId = extractSpreadsheetId(rawUrl);

    if (!spreadsheetId) {
        return await interaction.reply({
            content: t(lang, 'raid.setup.invalidUrl'),
            flags: [MessageFlags.Ephemeral]
        });
    }

    const columnToUpdate = customId === 'raid_setup_modal' ? 'raid_sheet_id' : 'logger_sheet_id';
    const configName = customId === 'raid_setup_modal' ? t(lang, 'raid.setup.raidSheet') : t(lang, 'raid.setup.loggerSheet');

    try {
        // Safely acquire pool instance dynamically
        const dbPool = db.pool || db;

        // Upsert configuration into MySQL table
        await dbPool.execute(
            `INSERT INTO server_settings (guild_id, ${columnToUpdate}) 
             VALUES (?, ?) 
             ON DUPLICATE KEY UPDATE ${columnToUpdate} = ?`,
            [guildId, spreadsheetId, spreadsheetId]
        );

        const botEmail = getServiceAccountEmail();
        return await interaction.reply({
            content: t(lang, 'raid.setup.configured', { name: configName, email: botEmail }),
            flags: [MessageFlags.Ephemeral]
        });
    } catch (error) {
        console.error('❌ Failed to save spreadsheet ID to database:', error);
        return await interaction.reply({
            content: t(lang, 'raid.setup.dbError'),
            flags: [MessageFlags.Ephemeral]
        });
    }
}

module.exports = { handleModal };