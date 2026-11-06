const path = require('path');
const { isMaintenance } = require('../../maintenance');
const { MessageFlags } = require('discord.js');
const { t } = require('../../utils/i18n');
const userLanguage = require('../../utils/userLanguage');

module.exports = {
    async handleInteraction(interaction) {
        // Maintenance Check: Block interaction when maintenance mode is ON (allows whitelisted servers to bypass)
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: t(await userLanguage.forInteraction(interaction), 'core.maintenance'),
                flags: [MessageFlags.Ephemeral]
            });
        }

        const statusCommandPath = path.join(__dirname, '..', '..', 'commands', 'status.js');
        const statusCommand = require(statusCommandPath);

        if (interaction.isStringSelectMenu() && typeof statusCommand.handleSelect === 'function') {
            return await statusCommand.handleSelect(interaction);
        }
        
        if (interaction.isButton() && typeof statusCommand.handleButton === 'function') {
            return await statusCommand.handleButton(interaction);
        }
    }
};