const OpenAI = require('openai');
const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { pool } = require('../utils/db');
const { isMaintenance } = require('../maintenance');

const openrouter = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
        'HTTP-Referer': 'https://discord.com',
        'X-Title': 'Discord Bot AI',
    }
});

// --- LOAD REFERENCE LINKS FROM DATA FOLDER ---
const referencesFilePath = path.join(__dirname, '../data/references.txt');

function getReferenceLinks() {
    try {
        if (fs.existsSync(referencesFilePath)) {
            return fs.readFileSync(referencesFilePath, 'utf8').trim();
        }
    } catch (e) {
        console.error('❌ Failed to read data/references.txt:', e);
    }
    return "No reference links provided.";
}

// Dynamically cache reference links on file load
const referenceLinksText = getReferenceLinks();

// --- IN-MEMORY CHAT HISTORY (RAM ONLY) ---
const chatHistoryMap = new Map();
const MAX_RAM_HISTORY = 15;

function getUserHistory(userId) {
    if (!chatHistoryMap.has(userId)) {
        chatHistoryMap.set(userId, []);
    }
    return chatHistoryMap.get(userId);
}

function appendToHistory(userId, role, content) {
    const history = getUserHistory(userId);
    history.push({ role, content });
    if (history.length > MAX_RAM_HISTORY) {
        history.shift();
    }
}

// --- DATABASE FETCHERS & MUTATORS ---
async function getAllUserFacts(userId) {
    try {
        const [rows] = await pool.execute(
            `SELECT fact_key, fact_value FROM user_facts WHERE user_id = ?`,
            [userId]
        );
        if (rows && rows.length > 0) {
            return rows.map(row => `- ${row.fact_key}: ${row.fact_value}`).join('\n');
        }
    } catch (e) {
        console.error('❌ Failed to load facts from MySQL:', e);
    }
    return "No specific facts saved.";
}

async function getActiveRemindersAndTasks(userId) {
    let output = "";
    try {
        const [reminderRows] = await pool.execute(
            `SELECT id, reminder_text, target_timestamp, is_recurring, recurrence_rule FROM reminders WHERE user_id = ? AND is_sent = FALSE ORDER BY target_timestamp ASC`,
            [userId]
        );
        if (reminderRows && reminderRows.length > 0) {
            output += "### Active Reminders:\n" + reminderRows.map(row => {
                const unixSeconds = Math.floor(new Date(row.target_timestamp).getTime() / 1000);
                const repeatTag = row.is_recurring ? ` 🔁 [Recurring: ${row.recurrence_rule || 'Daily'}]` : '';
                return `• [ID: ${row.id}] "${row.reminder_text}"${repeatTag} — <t:${unixSeconds}:f> (<t:${unixSeconds}:R>)`;
            }).join('\n') + "\n\n";
        } else {
            output += "### Active Reminders:\nNone found.\n\n";
        }

        const [taskRows] = await pool.execute(
            `SELECT fact_key, fact_value FROM user_facts WHERE user_id = ? AND fact_key LIKE 'task_%' ORDER BY LENGTH(fact_key) ASC, fact_key ASC`,
            [userId]
        );
        if (taskRows && taskRows.length > 0) {
            output += "### Task List:\n" + taskRows.map(row => `• ${row.fact_key}: ${row.fact_value}`).join('\n');
        } else {
            output += "### Task List:\nNone found.";
        }
    } catch (e) {
        console.error('❌ Failed to load records:', e);
        return "Error loading records.";
    }
    return output.trim();
}

async function setUserFact(userId, factKey, factValue) {
    try {
        await pool.execute(
            `INSERT INTO user_facts (user_id, fact_key, fact_value) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE fact_value = VALUES(fact_value)`,
            [userId, factKey, factValue]
        );
    } catch (e) {
        console.error(`❌ Failed to save fact [${factKey}]:`, e);
    }
}

async function appendUserFact(userId, factKey, textToAppend) {
    try {
        await pool.execute(
            `INSERT INTO user_facts (user_id, fact_key, fact_value) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE fact_value = CONCAT(fact_value, ' ', VALUES(fact_value))`,
            [userId, factKey, textToAppend]
        );
    } catch (e) {
        console.error(`❌ Failed to append fact [${factKey}]:`, e);
    }
}

async function editReminderText(userId, reminderId, newText) {
    try {
        await pool.execute(
            `UPDATE reminders SET reminder_text = ? WHERE id = ? AND user_id = ?`,
            [newText, reminderId, userId]
        );
    } catch (e) {
        console.error(`❌ Failed to update reminder:`, e);
    }
}

async function deleteUserFact(userId, factKey) {
    try {
        await pool.execute(`DELETE FROM user_facts WHERE user_id = ? AND fact_key = ?`, [userId, factKey]);
    } catch (e) {
        console.error(`❌ Failed to delete fact:`, e);
    }
}

async function clearAllUserReminders(userId) {
    try {
        await pool.execute(`DELETE FROM reminders WHERE user_id = ? AND is_sent = FALSE`, [userId]);
    } catch (e) {
        console.error(`❌ Failed to clear reminders:`, e);
    }
}

// Shared help list (same as /help)
const { buildHelpPayload } = require('../utils/helpContent');

// Utility to send long Discord messages safely
async function sendChunkedReply(message, content) {
    if (content.length <= 2000) {
        return await message.reply({ content });
    }

    const chunks = [];
    let current = content;

    while (current.length > 0) {
        if (current.length <= 2000) {
            chunks.push(current);
            break;
        }
        let cutIndex = current.lastIndexOf('\n', 2000);
        if (cutIndex === -1 || cutIndex < 1000) {
            cutIndex = current.lastIndexOf(' ', 2000);
        }
        if (cutIndex === -1 || cutIndex < 1000) {
            cutIndex = 2000;
        }

        chunks.push(current.substring(0, cutIndex));
        current = current.substring(cutIndex).trimStart();
    }

    await message.reply({ content: chunks[0] });
    for (let i = 1; i < chunks.length; i++) {
        await message.channel.send({ content: chunks[i] });
    }
}

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        if (isMaintenance(message.guildId) || message.author.bot || !message.guild) return;

        // Don't let the AI reply while the user is typing their Party Finder name in the /pf wizard
        const pfSession = global.pfSessions ? global.pfSessions.get(message.author.id) : null;
        if (pfSession && pfSession.step === 'name') return;

        const userId = message.author.id;
        const channelId = message.channelId;
        const guildId = message.guildId;
        const botId = message.client.user.id;

        // Pingway only answers in AI channels (/ailistenhere) or when someone @mentions it
        const mentionRe = new RegExp('<@!?' + botId + '>', 'g');
        const mentioned = mentionRe.test(message.content);
        let isAiChannel = false;
        try {
            const [aiRows] = await pool.execute(
                `SELECT channel_id FROM ai_active_channels WHERE guild_id = ? AND channel_id = ?`,
                [guildId, channelId]
            );
            isAiChannel = aiRows.length > 0;
        } catch (e) {
            console.error('❌ Failed to check AI channel:', e.message);
            return;
        }
        if (!isAiChannel && !mentioned) return;

        const userPrompt = message.content.replace(mentionRe, '').trim();
        const lowerPrompt = userPrompt.toLowerCase().trim();

        // --- QUICK REPLIES (no AI used) ---
        const helpWords = ['help', 'commands', 'command list', 'bot commands', 'pingway help', 'show commands', 'info', 'features', 'what can you do', 'website', 'dashboard'];
        if (helpWords.includes(lowerPrompt.replace(/[?!.]+$/, '')) || (mentioned && lowerPrompt === '')) {
            return message.reply({ content: 'Here is everything Pingway can do! You can also manage Pingway in your browser 🌐', ...buildHelpPayload() });
        }
        if (lowerPrompt === 'release recollection') {
            chatHistoryMap.delete(userId);
            return message.reply({ content: "✨ *Release_Recollection_PROTOCOL Initialized.* — RAM history wiped clean." });
        }
        if (lowerPrompt.includes('invite link') || lowerPrompt.includes('add the bot')) {
            return message.reply({ content: "Add Pingway using this link:\nhttps://discord.com/oauth2/authorize?client_id=1530586586524418048" });
        }
        if (lowerPrompt.includes('support link') || lowerPrompt.includes('help server')) {
            return message.reply({ content: "Join the support server here:\nhttps://discord.gg/DDdV48X4G2" });
        }
        if (['support dev', 'support developer', 'help dev', 'donate dev'].some(k => lowerPrompt.includes(k))) {
            return message.reply({ content: "💖 Support future updates and cover token costs here:\n<https://ko-fi.com/riverzola>" });
        }
        if (['are you a bot', 'are you ai'].some(k => lowerPrompt.includes(k))) {
            return message.reply({ content: "No, I'm the Developer manually replying. Send help. (Kidding, yes i am an AI) <https://ko-fi.com/riverzola>" });
        }
        if (['full code', 'write a script', 'generate code'].some(k => lowerPrompt.includes(k))) {
            return message.reply({ content: "I am prohibited by the Dev from generating large code files." });
        }

        // Mentioned outside an AI channel: point to /help instead of using AI here
        if (!isAiChannel) {
            return message.reply({ content: '👋 Hi! Type **/help** (or mention me with "help") to see what I can do. AI chat only works in channels an admin enabled with **/ailistenhere**.' });
        }

        try {

            await message.channel.sendTyping();

            const username = message.author.displayName;
            const userFactsList = await getAllUserFacts(userId);
            const activeRemindersAndTasksList = await getActiveRemindersAndTasks(userId);
            const userRAMHistory = getUserHistory(userId);
            const currentIsoDate = new Date().toISOString();

            // Sanitize user prompt to prevent action tag injection via echoing
            const safeUserPrompt = userPrompt.replace(/\[/g, '［').replace(/\]/g, '］');

            const systemMessage = `You are Pingway, an FFXIV utility bot. 
Time: ${currentIsoDate} (User: ${username}).
- Reminders: Output [REMINDER_JSON]{ "target_time": "ISO", "task": "...", "is_recurring": true/false, "recurrence_rule": "..." }[REMINDER_JSON]
- Edit Reminder: [EDIT_REMINDER_JSON]{ "id": 123, "new_text": "..." }[EDIT_REMINDER_JSON]
- Delete Reminder: [DELETE_REMINDER_JSON]{ "id": 123 }[DELETE_REMINDER_JSON]
- Clear Reminders: [CLEAR_ALL_REMINDERS]
- Facts: [SET_FACT] key = val | [APPEND_FACT] key = val | [DELETE_FACT] key
Keep replies natural and conversational.

When users ask for resources, links, or guides, refer to the reference links below when relevant:
--- REFERENCE LINKS & RESOURCES ---
${referenceLinksText}

--- DATABASE RECORDS ---
${activeRemindersAndTasksList}
--- SAVED FACTS ---
${userFactsList}`;

            const messagesPayload = [
                { role: 'system', content: systemMessage },
                ...userRAMHistory,
                { role: 'user', content: safeUserPrompt }
            ];

            const completion = await openrouter.chat.completions.create({
                model: 'google/gemini-2.5-flash',
                messages: messagesPayload,
                max_tokens: 1000
            });

            const aiReply = completion.choices[0]?.message?.content || "Done!";

            // --- DATABASE MUTATIONS & TRACKING FLAGS ---
            let reminderSavedCount = 0;
            let reminderEdited = false;
            let reminderDeleted = false;
            let remindersCleared = false;
            let isRecurringSaved = false;
            let factsSaved = 0;
            let factsAppended = 0;
            let factsDeleted = 0;

            // 1. Process Reminders
            const reminderJsonMatches = [...aiReply.matchAll(/\[REMINDER_JSON\]([\s\S]*?)\[REMINDER_JSON\]/gi)];
            for (const match of reminderJsonMatches) {
                try {
                    const data = JSON.parse(match[1].trim());
                    if (data.target_time && data.task) {
                        const ts = new Date(data.target_time).getTime();
                        if (!isNaN(ts)) {
                            isRecurringSaved = !!data.is_recurring;
                            await pool.execute(
                                `INSERT INTO reminders (guild_id, channel_id, user_id, reminder_text, target_timestamp, is_recurring, recurrence_rule, is_sent) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)`,
                                [guildId, channelId, userId, data.task, ts, isRecurringSaved, data.recurrence_rule || null]
                            );
                            reminderSavedCount++;
                        }
                    }
                } catch (e) { console.error('Reminder JSON Parse Error:', e); }
            }

            // 2. Process Edit Reminder
            const editMatch = aiReply.match(/\[EDIT_REMINDER_JSON\]([\s\S]*?)\[EDIT_REMINDER_JSON\]/i);
            if (editMatch) {
                try {
                    const d = JSON.parse(editMatch[1].trim());
                    if (d.id && d.new_text) {
                        await editReminderText(userId, d.id, d.new_text);
                        reminderEdited = true;
                    }
                } catch (e) { console.error('Edit JSON Parse Error:', e); }
            }

            // 3. Process Delete Reminder
            const delMatch = aiReply.match(/\[DELETE_REMINDER_JSON\]([\s\S]*?)\[DELETE_REMINDER_JSON\]/i);
            if (delMatch) {
                try {
                    const d = JSON.parse(delMatch[1].trim());
                    if (d.id) {
                        await pool.execute(`DELETE FROM reminders WHERE id = ? AND user_id = ?`, [d.id, userId]);
                        reminderDeleted = true;
                    }
                } catch (e) { console.error('Delete JSON Parse Error:', e); }
            }

            // 4. Process Clear All
            if (aiReply.includes('[CLEAR_ALL_REMINDERS]')) {
                await clearAllUserReminders(userId);
                remindersCleared = true;
            }

            // 5. Process Fact Commands Safely
            const setFactMatches = [...aiReply.matchAll(/\[SET_FACT\]\s*([^=]+?)\s*=\s*(.+)/gi)];
            for (const match of setFactMatches) {
                await setUserFact(userId, match[1].trim().toLowerCase().replace(/\s+/g, '_'), match[2].trim());
                factsSaved++;
            }

            const appendFactMatches = [...aiReply.matchAll(/\[APPEND_FACT\]\s*([^=]+?)\s*=\s*(.+)/gi)];
            for (const match of appendFactMatches) {
                await appendUserFact(userId, match[1].trim().toLowerCase().replace(/\s+/g, '_'), match[2].trim());
                factsAppended++;
            }

            const delFactMatches = [...aiReply.matchAll(/\[DELETE_FACT\]\s*(.+)/gi)];
            for (const match of delFactMatches) {
                await deleteUserFact(userId, match[1].trim().toLowerCase().replace(/\s+/g, '_'));
                factsDeleted++;
            }

            // Clean action tags from output text
            const cleanReply = aiReply
                .replace(/\[REMINDER_JSON\][\s\S]*?\[REMINDER_JSON\]/gim, '')
                .replace(/\[EDIT_REMINDER_JSON\][\s\S]*?\[EDIT_REMINDER_JSON\]/gim, '')
                .replace(/\[DELETE_REMINDER_JSON\][\s\S]*?\[DELETE_REMINDER_JSON\]/gim, '')
                .replace(/\[CLEAR_ALL_REMINDERS\]/gim, '')
                .replace(/\[SET_FACT\].*$/gim, '')
                .replace(/\[APPEND_FACT\].*$/gim, '')
                .replace(/\[DELETE_FACT\].*$/gim, '')
                .trim();

            // Append context history clean of system tags
            appendToHistory(userId, 'user', userPrompt);
            appendToHistory(userId, 'assistant', cleanReply || "Done!");

            // Generate System Notification
            let staticNotice = "";
            if (remindersCleared) {
                staticNotice = "\n\n🗑️ *[System: Cleared entire reminder/task list]*";
            } else if (reminderEdited) {
                staticNotice = "\n\n✏️ *[System: Updated reminder text]*";
            } else if (reminderDeleted) {
                staticNotice = "\n\n🗑️ *[System: Removed specific reminder]*";
            } else if (reminderSavedCount > 0) {
                const repeatNotice = isRecurringSaved ? " (Daily Recurring 🔁)" : "";
                const countTag = reminderSavedCount > 1 ? ` (${reminderSavedCount} saved)` : '';
                staticNotice = `\n\n⏰ *[System: Reminder set${repeatNotice}${countTag}]*`;
            } else if (factsAppended > 0) {
                staticNotice = "\n\n📝 *[System: Appended text to fact/note]*";
            } else if (factsDeleted > 0) {
                staticNotice = "\n\n🧹 *[System: Forgot saved fact]*";
            } else if (factsSaved > 0) {
                staticNotice = "\n\n🧠 *[System: Saved new fact]*";
            }

            const finalReply = (cleanReply || "Done!") + staticNotice;
            await sendChunkedReply(message, finalReply);

        } catch (error) {
            console.error('[token debug] Error:', error);
        }
    }
};