const { PermissionFlagsBits } = require('discord.js');

module.exports = {
  name: 'clientReady',
  once: true,

  execute(client) {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`   Serving ${client.guilds.cache.size} guild(s).`);
    console.log(`   Run "npm run deploy" once to register slash commands.`);

    // ── Invite URL ─────────────────────────────────────────────────────────
    const permissions =
      PermissionFlagsBits.ViewChannel |
      PermissionFlagsBits.SendMessages |
      PermissionFlagsBits.EmbedLinks |
      PermissionFlagsBits.ReadMessageHistory |
      PermissionFlagsBits.CreatePublicThreads |
      PermissionFlagsBits.SendMessagesInThreads |
      PermissionFlagsBits.ManageThreads;

    const inviteUrl =
      `https://discord.com/api/oauth2/authorize` +
      `?client_id=${client.user.id}` +
      `&permissions=${permissions}` +
      `&scope=bot%20applications.commands`;

    console.log(`\n🔗 Invite URL (all required permissions):\n   ${inviteUrl}\n`);
  },
};
