module.exports = {
  name: 'ready',
  once: true,

  execute(client) {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`   Serving ${client.guilds.cache.size} guild(s).`);
    console.log(`   Run "npm run deploy" once to register slash commands.`);
  },
};
