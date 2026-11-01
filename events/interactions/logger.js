const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { pool } = require('../../utils/db');
const { isMaintenance } = require('../../maintenance');

const SHEET_NAME = 'Sheet1';
const CREDENTIALS_PATH = path.join(__dirname, '..', '..', 'google-credentials.json');

let sheetsApi = null;

function getSheetsApi() {
    try {
        if (sheetsApi) return sheetsApi;
        if (!fs.existsSync(CREDENTIALS_PATH)) {
            return null;
        }
        
        const auth = new google.auth.GoogleAuth({
            keyFile: CREDENTIALS_PATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        
        sheetsApi = google.sheets({ version: 'v4', auth });
        return sheetsApi;
    } catch (error) {
        console.error('❌ Failed to initialize Google Sheets API for logger:', error.message);
        return null;
    }
}

async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || !interaction.guildId) return;

    // Maintenance Check: Skip logging if maintenance mode is ON and guild is not whitelisted
    if (isMaintenance(interaction.guildId)) {
        return;
    }

    try {
        // Fetch logger sheet ID from database for this specific server
        const [rows] = await pool.execute(
            'SELECT logger_sheet_id FROM server_settings WHERE guild_id = ?',
            [interaction.guildId]
        );

        const spreadsheetId = rows[0]?.logger_sheet_id;
        if (!spreadsheetId) {
            return; 
        }

        const api = getSheetsApi();
        if (!api) {
            return;
        }

        const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }) + ' JST';
        const userTag = interaction.user.tag || `${interaction.user.username}`;
        const userId = interaction.user.id;
        const guildName = interaction.guild ? interaction.guild.name : 'Direct Message';
        const guildId = interaction.guild.id;
        const channelName = interaction.channel ? `#${interaction.channel.name}` : 'N/A';
        const commandName = `/${interaction.commandName}`;

        let optionsSummary = 'None';
        if (interaction.options && interaction.options.data.length > 0) {
            optionsSummary = interaction.options.data
                .map(opt => `${opt.name}: ${opt.value}`)
                .join(', ');
        }

        const rowData = [timestamp, userTag, userId, guildName, guildId, channelName, commandName, optionsSummary];

        await api.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: `${SHEET_NAME}!A:H`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowData] }
        });
    } catch (error) {
        console.error('❌ Failed to log command to Google Sheets:', error.message);
    }
}

module.exports = { handleInteraction };