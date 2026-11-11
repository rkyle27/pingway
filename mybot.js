require('dotenv').config();
require('./utils/welcomeCards'); // welcome card fonts: must load before any other canvas use
const { Client, GatewayIntentBits, Collection, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Import the Party Finder Scheduler utility
const { startPfScheduler } = require('./utils/pfScheduler');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions // reaction roles
    ]
});

// --- Global Config ---
global.pfSessions = new Map();
global.botConfig = {
    guildSettings: {}
};

// --- Command Loading with Detailed Debugging ---
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');

console.log(`\n🔍 [BOOT DEBUG] Scanning commands directory: ${commandsPath}`);
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
    console.log(`📂 [BOOT DEBUG] Found ${commandFiles.length} command file(s): [${commandFiles.join(', ')}]`);

    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        try {
            const cmd = require(filePath);
            if (cmd?.data?.name) {
                client.commands.set(cmd.data.name, cmd);
                console.log(`  ✅ Successfully loaded command: /${cmd.data.name} from file '${file}'`);
            } else {
                console.warn(`  ⚠️ Warning: File '${file}' was read but lacks a valid 'data.name' property.`);
            }
        } catch (err) {
            console.error(`  ❌ CRITICAL: Failed to require/load command file '${file}':`, err);
        }
    }
} else {
    console.error(`❌ [BOOT DEBUG] Commands directory not found at: ${commandsPath}`);
}

// --- Event Loading with Detailed Debugging ---
const eventsPath = path.join(__dirname, 'events');

console.log(`\n🔍 [BOOT DEBUG] Scanning events directory: ${eventsPath}`);
if (fs.existsSync(eventsPath)) {
    const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));
    console.log(`📂 [BOOT DEBUG] Found ${eventFiles.length} event file(s): [${eventFiles.join(', ')}]`);

    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        try {
            const event = require(filePath);
            if (!event.name || typeof event.execute !== 'function') {
                console.warn(`  ⚠️ Warning: Event file '${file}' is missing a 'name' or 'execute' function.`);
                continue;
            }

            if (event.once) {
                client.once(event.name, (...args) => event.execute(...args, client));
                console.log(`  ✅ Successfully bound ONE-TIME event '${event.name}' from '${file}'`);
            } else {
                client.on(event.name, (...args) => event.execute(...args, client));
                console.log(`  ✅ Successfully bound EVENT listener '${event.name}' from '${file}'`);
            }
        } catch (err) {
            console.error(`  ❌ CRITICAL: Failed to load event file '${file}':`, err);
        }
    }
} else {
    console.error(`❌ [BOOT DEBUG] Events directory not found at: ${eventsPath}`);
}
console.log(''); // Spacing for clean terminal output

// --- PF Wizard Input Listener ---
client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const session = global.pfSessions.get(message.author.id);
    if (session?.step === 'name') {
        session.data.name = message.content;
        session.step = 'size';

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('pf_size_4').setLabel('4 People').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('pf_size_8').setLabel('8 People').setStyle(ButtonStyle.Primary)
        );
        return message.reply({ content: "Step 2/4: Is this a 4-person or 8-person party?", components: [row] });
    }
});

// --- Background Services ---
client.once(Events.ClientReady, () => {
    console.log(`🚀 [SCHEDULER] Starting background clock services...`);
    startPfScheduler(client);
    require('./utils/honeypot').start(client); // "do not chat here" channels
    require('./utils/reactionRoles').start(client); // emoji -> role messages (website)
    require('./utils/tickets').start(client); // help desk tickets (website)
    require('./utils/lodestoneNews').start(client); // FFXIV news channels (website)
    require('./utils/voteRewards').start(client); // top.gg vote thank-you DMs (points added by the website)
    require('./utils/heartbeat').start(); // Online / Maintenance / Offline status on the website
    require('./utils/guildSheets').start(client); // Raid & Logger sheets: website requests, sharing, Supporter Perks limits
    require('./utils/trivia').start(client); // Pingway Trivia: word bank from XIVAPI (data/trivia_bank.json), tables, cleanup
    require('./utils/welcome').start(client); // Welcome cards for new members (/welcomehere + website)
    require('./utils/guildLanguage').start(); // Server language card (website): overrides the server's Discord language for posts
    // Website jobs (command_queue): checked every ~5 s, the result is written back
    require('./utils/commandQueue').start(require('./utils/db').pool, {
        triviaShare: (userId, args) => require('./utils/triviaShare').run(client, userId, args), // website Trivia Share box
        runPrivate: privateHooks ? privateHooks.runQueueRow : null
    });

    // One-time points conversion check (see ensurePointsMigration below)
    setTimeout(async () => {
        await ensurePointsMigration(require('./utils/db').pool).catch(err => console.error('⚠️ [POINTS] Conversion check failed:', err.message));
    }, 15000);
});

const POINTS_MIGRATION = 'credits_to_points_x10_2026_11';

// Nov 2026: credits became points worth 10x. The website runs the same one-time step; whichever runs first wins
// (the bot_migrations insert can only succeed once), so balances are never multiplied twice.
async function ensurePointsMigration(pool) {
    await pool.execute('CREATE TABLE IF NOT EXISTS bot_migrations (name VARCHAR(100) PRIMARY KEY, ran_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    const [done] = await pool.execute('SELECT name FROM bot_migrations WHERE name = ?', [POINTS_MIGRATION]);
    if (done.length) return;
    const [tables] = await pool.query("SHOW TABLES LIKE 'credit_lots'");
    if (!tables.length) return; // Retainer Watch never used: the website sets everything up later
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        try {
            await conn.execute('INSERT INTO bot_migrations (name) VALUES (?)', [POINTS_MIGRATION]);
        } catch (e) {
            if (e.code === 'ER_DUP_ENTRY') { await conn.rollback(); return; }
            throw e;
        }
        await conn.execute('UPDATE credit_lots SET credits_total = credits_total * 10, credits_left = credits_left * 10');
        const [kp] = await conn.query("SHOW TABLES LIKE 'kofi_payments'");
        if (kp.length) await conn.execute('UPDATE kofi_payments SET credits = credits * 10');
        await conn.commit();
        console.log('🔄 One-time migration done: credits are now points (x10).');
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }
}

// --- Optional private module (not in the public repository); without it the bot runs all public features normally ---
const { loadPrivate } = require('./utils/privateHook');
const privateConsole = loadPrivate('console');
const privateHooks = privateConsole ? privateConsole.start({ client, ensurePointsMigration }) : null;

// --- Crash Safety Net (log errors instead of crashing the bot) ---
process.on('unhandledRejection', (reason) => {
    const { isDiscordApiError, isSlowError, apiWhere, redactApiError } = require('./utils/discordErrors');
    if (isSlowError(reason)) {
        // Interaction expired / already answered (slow host) - one short line, no dump
        console.error(`⏱️ [SLOW] [UNHANDLED REJECTION] ${reason.message} (${reason.code}) | ${apiWhere(reason)}`);
        return;
    }
    if (isDiscordApiError(reason)) {
        // Never dump reason itself: its url holds the interaction token
        console.error(`❌ [UNHANDLED REJECTION] DiscordAPIError ${reason.code} | ${apiWhere(reason)}`, redactApiError(reason));
        return;
    }
    console.error('❌ [UNHANDLED REJECTION]', reason);
});
process.on('uncaughtException', (err) => {
    console.error('❌ [UNCAUGHT EXCEPTION]', err);
});
client.on(Events.Error, (err) => {
    console.error('❌ [DISCORD CLIENT ERROR]', err);
});

// --- Client Login ---
client.login(process.env.DISCORD_TOKEN);