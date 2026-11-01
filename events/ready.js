const { Events, ActivityType, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const releaseManager = require('../releaseManager');
const { startFirmamentScheduler } = require('../utils/firmamentScheduler');
const { startReminderScheduler } = require('../utils/reminderScheduler');
const { initStatusChecker } = require('../utils/statusChecker');
const { initDatabase } = require('../utils/db');
const { initMarketMonitor } = require('../utils/marketMonitor');

const crypto = require('crypto');
const COMMAND_HASH_FILE = path.join(__dirname, '..', 'data', 'command_hashes.json');

function hashCommand(cmd) {
    return crypto.createHash('sha1').update(JSON.stringify(cmd)).digest('hex');
}

// Only registers slash commands that are new or changed since the last start.
// Delete data/command_hashes.json to force a full re-register of every command.
async function syncSlashCommands(rest, appId, commands) {
    let saved = null;
    try {
        if (fs.existsSync(COMMAND_HASH_FILE)) saved = JSON.parse(fs.readFileSync(COMMAND_HASH_FILE, 'utf8'));
    } catch (e) {
        saved = null;
    }

    const current = {};
    for (const cmd of commands) current[cmd.name] = hashCommand(cmd);

    if (!saved) {
        console.log('Registering all ' + commands.length + ' slash commands (first run of change tracking)...');
        await rest.put(Routes.applicationCommands(appId), { body: commands });
        console.log('Successfully registered all application (/) commands.');
    } else {
        const changed = commands.filter(cmd => saved[cmd.name] !== current[cmd.name]);
        const removed = Object.keys(saved).filter(name => !current[name]);
        if (changed.length === 0 && removed.length === 0) {
            console.log('Slash commands unchanged (' + commands.length + '). Skipping registration.');
            return;
        }
        for (const cmd of changed) {
            await rest.post(Routes.applicationCommands(appId), { body: cmd }); // creates or updates the command by name
            console.log('  ✅ Registered changed command: /' + cmd.name);
        }
        if (removed.length > 0) {
            const existing = await rest.get(Routes.applicationCommands(appId));
            for (const name of removed) {
                const found = existing.find(c => c.name === name);
                if (found) {
                    await rest.delete(Routes.applicationCommand(appId, found.id));
                    console.log('  🗑️ Removed deleted command: /' + name);
                }
            }
        }
    }

    try {
        fs.writeFileSync(COMMAND_HASH_FILE, JSON.stringify(current, null, 2), 'utf8');
    } catch (e) {
        console.error('⚠️ Could not save data/command_hashes.json:', e.message);
    }
}

let dbInitialized = false;

module.exports = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        console.log(`Logged in as ${client.user.tag}!`);

        // --- Initialize Database Tables on Discord Ready ---
        if (!dbInitialized) {
            try {
                await initDatabase();
                dbInitialized = true;
            } catch (dbError) {
                console.error('❌ Failed to initialize database tables on startup:', dbError);
            }
        }

        // --- Auto-Deploy Slash Commands ---
        try {
            const commands = [];
            const commandsPath = path.join(__dirname, '..', 'commands');
            const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

            for (const file of commandFiles) {
                const filePath = path.join(commandsPath, file);
                const command = require(filePath);
                if ('data' in command && 'execute' in command) {
                    let commandData = command.data;
                    if (typeof commandData.toJSON === 'function') {
                        commandData = commandData.toJSON();
                    }
                    if (!commandData.description) {
                        commandData.description = `Execute the ${commandData.name} command`;
                    }
                    commands.push(commandData);
                }
            }

            const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
            await syncSlashCommands(rest, client.user.id, commands);
        } catch (error) {
            console.error('Failed to auto-deploy slash commands:', error);
        }

        // Set bot presence
        client.user.setPresence({
            activities: [{ name: 'FFXIV Timers & Countdowns', type: ActivityType.Watching }],
            status: 'online',
        });

        // Start Release Scheduler
        if (releaseManager && typeof releaseManager.startEvercoldScheduler === 'function') {
            releaseManager.startEvercoldScheduler(client);
        }

        // Start Firmament Background DM Scheduler
        startFirmamentScheduler(client);

        // Start AI Reminder Background Scheduler
        startReminderScheduler(client);

        // Start FFXIV Server Status Checker Background Service (Every 10s)
        initStatusChecker(client);

        // Start Universalis Market Live Monitor Feed
        initMarketMonitor(client);

        // --- All Systems Ready Confirmation ---
        console.log(`\n==================================================`);
        console.log(`🟢 BOT IS FULLY READY, RUNNING, AND ALL SERVICES ARE UP!`);
        console.log(`==================================================\n`);
    }
};