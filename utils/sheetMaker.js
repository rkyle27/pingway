// Google Sheets that Pingway makes itself (Raid & Logger): copy a template, share it as "anyone with the link can
// edit", and delete it again when an admin removes it. Uses the bot's Google service account
// (google-credentials.json). No email addresses are used or stored.

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const CREDENTIALS_PATH = path.join(__dirname, '..', 'google-credentials.json');
const RAID_TEMPLATE_ID = '1ud9oeY779L94Es91Jix9OXApXaxU8mW1k025KWLrffE';

let apis = null;
function getApis() {
    if (apis) return apis;
    if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error('google-credentials.json is missing');
    const auth = new google.auth.GoogleAuth({
        keyFile: CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
    });
    apis = { drive: google.drive({ version: 'v3', auth }), sheets: google.sheets({ version: 'v4', auth }) };
    return apis;
}

async function shareAnyoneCanEdit(fileId) {
    await getApis().drive.permissions.create({ fileId, requestBody: { type: 'anyone', role: 'writer' } });
}

// Returns the new spreadsheet ID
async function copyTemplate(templateId, title) {
    const r = await getApis().drive.files.copy({ fileId: templateId, requestBody: { name: title }, fields: 'id' });
    await shareAnyoneCanEdit(r.data.id);
    return r.data.id;
}

async function createBlank(title) {
    const r = await getApis().sheets.spreadsheets.create({ requestBody: { properties: { title } }, fields: 'spreadsheetId' });
    await shareAnyoneCanEdit(r.data.spreadsheetId);
    return r.data.spreadsheetId;
}

async function deleteSheet(fileId) {
    await getApis().drive.files.delete({ fileId });
}

// One-time check: can this service account create, share and delete files? (Newer Google service accounts can
// have no Drive storage, which makes creating files fail.) Logs the result only - nothing is kept.
async function selfTest() {
    const steps = [];
    try {
        const about = await getApis().drive.about.get({ fields: 'storageQuota' });
        const q = about.data.storageQuota || {};
        steps.push('storage ' + (q.limit ? Math.round(Number(q.limit) / 1e9) + ' GB limit' : 'no limit field') + ', ' + Math.round(Number(q.usage || 0) / 1e6) + ' MB used');
        const blank = await createBlank('Pingway self-test (deleted right away)');
        steps.push('create blank ✅');
        await deleteSheet(blank);
        steps.push('delete ✅');
        const copy = await copyTemplate(RAID_TEMPLATE_ID, 'Pingway self-test copy (deleted right away)');
        steps.push('copy template + share ✅');
        await deleteSheet(copy);
        steps.push('delete copy ✅');
        console.log('🧪 [SHEETS] Self-test passed: ' + steps.join(' · '));
    } catch (err) {
        const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.code || '';
        console.log('🧪 [SHEETS] Self-test stopped after: ' + (steps.join(' · ') || 'nothing') + ' → ' + reason + ' ' + err.message);
    }
}

// Runs the self-test only when a file named sheets-selftest.flag is in the bot folder (then removes the flag)
function selfTestIfAsked() {
    const flag = path.join(__dirname, '..', 'sheets-selftest.flag');
    if (!fs.existsSync(flag)) return;
    try { fs.unlinkSync(flag); } catch (e) { /* ignore */ }
    selfTest();
}

module.exports = { RAID_TEMPLATE_ID, copyTemplate, createBlank, deleteSheet, shareAnyoneCanEdit, selfTest, selfTestIfAsked, getApis };
