const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { pool } = require('../../utils/db');

const CREDENTIALS_PATH = path.join(__dirname, '..', '..', 'google-credentials.json');

/**
 * Safely parses date strings (MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD) from sheet cells.
 */
function parseCellDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return null;
    const cleanStr = dateStr.trim();

    const mdYMatch = cleanStr.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
    if (mdYMatch) {
        const month = parseInt(mdYMatch[1], 10) - 1;
        const day = parseInt(mdYMatch[2], 10);
        const year = parseInt(mdYMatch[3], 10);
        const date = new Date(year, month, day);
        if (!isNaN(date.getTime())) return date;
    }

    const nativeDate = new Date(cleanStr);
    if (!isNaN(nativeDate.getTime())) return nativeDate;

    return null;
}

/**
 * Creates an authenticated Google Sheets API client using service account credentials.
 */
function getGoogleSheetsClient() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        throw new Error('google-credentials.json file is missing from the bot root directory.');
    }

    const auth = new google.auth.GoogleAuth({
        keyFile: CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    return google.sheets({ version: 'v4', auth });
}

/**
 * Fetches the raid schedule from the configured Google Sheet for a given server.
 * Uses fixed layout: Column C for dates, Column M for status formula output, Row 1 for player headers (E-L).
 */
async function fetchRaidSchedule(guildId) {
    try {
        // 1. Fetch spreadsheet ID for this guild from MySQL database
        const [rows] = await pool.execute('SELECT raid_sheet_id FROM server_settings WHERE guild_id = ?', [guildId]);
        const spreadsheetId = rows[0]?.raid_sheet_id;

        if (!spreadsheetId) {
            return '⚠️ **Raid Planner Sheet not configured!** An administrator must configure the sheet link first.';
        }

        // 2. Query Google Sheets API for sheet data
        const sheets = getGoogleSheetsClient();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'A1:Z100',
            valueRenderOption: 'FORMATTED_VALUE',
        });

        const sheetValues = response.data.values;
        if (!sheetValues || sheetValues.length === 0) {
            return '❌ **No data found in the Raid Planner Sheet.**';
        }

        // Row 1 (index 0) contains player names in Columns E through L (indices 4 to 11)
        const playerHeaders = sheetValues[0] || [];

        // Data rows start from Row 2 (index 1) onward, filtering by Column C (index 2) for valid dates
        const dataRows = sheetValues.slice(1).filter(row => {
            if (!row || !row[2]) return false;
            return parseCellDate(row[2]) !== null;
        });

        if (dataRows.length === 0) {
            return '❌ **Could not parse any valid date entries in the Google Sheet.**';
        }

        // 3. Find starting index relative to current date
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let startIndex = dataRows.findIndex(row => {
            const rowDate = parseCellDate(row[2]);
            if (!rowDate) return false;
            rowDate.setHours(0, 0, 0, 0);

            return rowDate >= today;
        });

        if (startIndex === -1) {
            startIndex = 0;
        }

        // 4. Process next 7 consecutive date entries
        const next7Entries = dataRows.slice(startIndex, startIndex + 7);
        const scheduleOutputs = [];

        for (const row of next7Entries) {
            const dateStr = row[2]?.trim();      // Column C
            const dayOfWeek = row[3]?.trim();    // Column D
            const statusUpper = row[12]?.trim().toUpperCase(); // Column M (=IF formula result)

            const validStatuses = ['RAID', 'UNSURE', 'NO', 'FILL PLEASE'];
            if (!dateStr || !statusUpper || !validStatuses.includes(statusUpper)) {
                continue;
            }

            const availablePlayers = [];
            const unsurePlayers = [];
            const latePlayers = [];
            const subbedPlayers = []; // <--- Added Subbed array
            const absentPlayers = [];
            const pendingPlayers = [];

            if (statusUpper === 'FILL PLEASE') {
                // Collect players who have no value entered
                for (let i = 4; i <= 11; i++) {
                    const playerName = playerHeaders[i]?.trim();
                    if (!playerName) continue;

                    const val = row[i]?.trim();
                    if (!val) {
                        pendingPlayers.push(playerName);
                    }
                }
            } else {
                // Check player responses in Columns E (index 4) through L (index 11)
                for (let i = 4; i <= 11; i++) {
                    const playerName = playerHeaders[i]?.trim();
                    if (!playerName) continue;

                    const val = row[i]?.trim().toUpperCase();

                    if (statusUpper === 'RAID' || statusUpper === 'UNSURE') {
                        if (val === 'O') availablePlayers.push(playerName);
                        if (val === 'Δ' || val === '△') unsurePlayers.push(playerName);
                        if (val === 'L') latePlayers.push(playerName);
                        if (val === 'S') subbedPlayers.push(playerName); // <--- Handles 'S'
                        if (val === 'X') absentPlayers.push(playerName);

                    } else if (statusUpper === 'NO') {
                        if (val === 'Δ' || val === '△') unsurePlayers.push(playerName);
                        if (val === 'L') latePlayers.push(playerName);
                        if (val === 'S') subbedPlayers.push(playerName); // <--- Handles 'S'
                        if (val === 'X') absentPlayers.push(playerName);
                    }
                }
            }

            let statusEmoji = '';
            if (statusUpper === 'RAID') statusEmoji = '⚔️ **RAID**';
            if (statusUpper === 'UNSURE') statusEmoji = '❓ **UNSURE**';
            if (statusUpper === 'FILL PLEASE') statusEmoji = '📝 **FILL PLEASE**';
            if (statusUpper === 'NO') statusEmoji = '❌ **NO RAID**';

            let entryText = `📅 **${dateStr}${dayOfWeek ? ` (${dayOfWeek})` : ''}** - ${statusEmoji}\n`;

            if (statusUpper === 'FILL PLEASE') {
                if (pendingPlayers.length > 0) {
                    entryText += `> 📝 **Pending Response (${pendingPlayers.length}):** ${pendingPlayers.join(', ')}\n`;
                }
            } else {
                if (availablePlayers.length > 0) {
                    entryText += `> ✅ **Available (${availablePlayers.length}):** ${availablePlayers.join(', ')}\n`;
                }
                if (latePlayers.length > 0) {
                    entryText += `> ⏰ **Late (${latePlayers.length}):** ${latePlayers.join(', ')}\n`;
                }
                if (subbedPlayers.length > 0) {
                    entryText += `> 🟡 **Subbed (${subbedPlayers.length}):** ${subbedPlayers.join(', ')}\n`; // <--- Renders Subbed players
                }
                if (unsurePlayers.length > 0) {
                    entryText += `> ❓ **Unsure (${unsurePlayers.length}):** ${unsurePlayers.join(', ')}\n`;
                }
                if (absentPlayers.length > 0) {
                    entryText += `> ❌ **Absent (${absentPlayers.length}):** ${absentPlayers.join(', ')}\n`;
                }
            }

            scheduleOutputs.push(entryText.trim());
        }

        if (scheduleOutputs.length === 0) {
            return 'ℹ️ **No raid days scheduled found.**\nMake sure to not change the layout and on correct date format.';
        }

        return `📊 **Upcoming Raid Schedule:**\n\n${scheduleOutputs.join('\n\n')}`;

    } catch (error) {
        console.error('❌ Error fetching raid schedule from Google Sheets:', error);
        if (error.code === 403 || error.code === 404) {
            return '❌ **Google Sheets API Access Error:** Please make sure the sheet is shared with the bot service account email and that the link is correct.';
        }
        return '❌ **Failed to retrieve raid schedule.** Please check the console log for details.';
    }
}

module.exports = { fetchRaidSchedule };