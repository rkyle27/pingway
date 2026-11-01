const path = require('path');
const { isMaintenance } = require('../../maintenance');
const { MessageFlags } = require('discord.js');

module.exports = {
    async handleInteraction(interaction) {
        // Maintenance Check: Block interaction when maintenance mode is ON (allows whitelisted servers to bypass)
        if (isMaintenance(interaction.guildId)) {
            return interaction.reply({
                content: '⚠️ **The bot is currently undergoing maintenance.** Please try again later!',
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