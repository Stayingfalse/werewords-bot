'use strict';

const crypto = require('crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionsBitField,
} = require('discord.js');

const settingsRepo = require('../dashboard/SettingsRepository');

const ROLE_MENU_FEATURE_ID = 'rolemenu';
const ROLE_MENU_BUTTON_PREFIX = 'rmr:';
const MAX_ROLE_OPTIONS = 20;
const MAX_STORED_ROLE_MENUS = 25;

const BUTTON_STYLE_MAP = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

function normalizeString(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed || null;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
    if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  }
  return fallback;
}

function normalizeRoleId(value) {
  const id = normalizeString(value);
  return id && /^\d{17,20}$/.test(id) ? id : null;
}

function normalizeEmoji(value) {
  const emoji = normalizeString(value);
  if (!emoji || emoji.length > 40) return null;
  const looksLikeCustom = /^<a?:\w{2,32}:\d{17,20}>$/.test(emoji);
  const looksLikeUnicode = /\p{Emoji}/u.test(emoji);
  return looksLikeCustom || looksLikeUnicode ? emoji : null;
}

function normalizeRoleOption(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const roleId = normalizeRoleId(raw.roleId);
  if (!roleId) return null;

  const fallbackLabel = `Role ${index + 1}`;
  const label = normalizeString(raw.label) || fallbackLabel;
  const emoji = normalizeEmoji(raw.emoji);
  const styleKey = String(raw.style || 'secondary').toLowerCase();
  const style = BUTTON_STYLE_MAP[styleKey] ?? ButtonStyle.Secondary;

  return { roleId, label: label.slice(0, 80), emoji, style };
}

function parseRoleOptions(extra) {
  if (!extra || typeof extra !== 'object' || !Array.isArray(extra.roleOptions)) return [];
  return extra.roleOptions
    .map((option, index) => normalizeRoleOption(option, index))
    .filter(Boolean)
    .slice(0, MAX_ROLE_OPTIONS);
}

function normalizeMenuId(value, fallbackIndex = 0) {
  const id = normalizeString(value);
  if (id && /^[a-zA-Z0-9_-]{3,24}$/.test(id)) return id;
  return `menu${fallbackIndex + 1}`;
}

function normalizeStoredRoleMenu(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const roleOptions = parseRoleOptions({ roleOptions: raw.roleOptions });
  if (!roleOptions.length) return null;
  return {
    menuId: normalizeMenuId(raw.menuId, index),
    messageId: normalizeString(raw.messageId),
    menuChannelId: normalizeRoleId(raw.menuChannelId),
    title: normalizeString(raw.title) || 'Role Menu: Roles',
    description: normalizeString(raw.description) || 'Use the buttons below to toggle your roles.',
    singleSelect: normalizeBoolean(raw.singleSelect, false),
    roleOptions,
  };
}

function parseStoredRoleMenus(extra) {
  if (!extra || typeof extra !== 'object') return [];

  const fromArray = Array.isArray(extra.roleMenus)
    ? extra.roleMenus
      .map((menu, index) => normalizeStoredRoleMenu(menu, index))
      .filter(Boolean)
      .slice(0, MAX_STORED_ROLE_MENUS)
    : [];

  if (fromArray.length) return fromArray;

  const legacyRoleOptions = parseRoleOptions(extra);
  if (!legacyRoleOptions.length) return [];

  return [{
    menuId: normalizeMenuId(extra.menuId || extra.roleMenuMessageId || 'menu1', 0),
    messageId: normalizeString(extra.roleMenuMessageId),
    menuChannelId: normalizeRoleId(extra.menuChannelId),
    title: normalizeString(extra.title) || 'Role Menu: Roles',
    description: normalizeString(extra.description) || 'Use the buttons below to toggle your roles.',
    singleSelect: normalizeBoolean(extra.singleSelect, false),
    roleOptions: legacyRoleOptions,
  }];
}

function getRoleMenuSettings(guildId) {
  let row = null;
  try {
    row = settingsRepo.getGuildSettings(guildId)?.[ROLE_MENU_FEATURE_ID] ?? null;
  } catch (err) {
    console.error('[RoleMenu] Failed to load guild settings:', err.message);
  }

  const extra = row && row.extra && typeof row.extra === 'object' ? row.extra : {};
  return {
    enabled: row?.enabled === true,
    channelIds: Array.isArray(row?.channelIds) && row.channelIds.length > 0
      ? row.channelIds.map((id) => String(id))
      : null,
    menuChannelId: normalizeString(extra.menuChannelId),
    roleMenuMessageId: normalizeString(extra.roleMenuMessageId),
    title: normalizeString(extra.title) || 'Role Menu: Roles',
    description: normalizeString(extra.description) || 'Use the buttons below to toggle your roles.',
    singleSelect: normalizeBoolean(extra.singleSelect, false),
    roleOptions: parseRoleOptions(extra),
    roleMenus: parseStoredRoleMenus(extra),
    extra,
  };
}

function parseComponentEmoji(emoji) {
  const custom = /^<(a?):(\w{2,32}):(\d{17,20})>$/.exec(String(emoji || ''));
  if (!custom) return emoji;
  return {
    animated: custom[1] === 'a',
    name: custom[2],
    id: custom[3],
  };
}

function buildRoleMenuComponents(roleOptions, menuId) {
  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (let i = 0; i < roleOptions.length; i += 1) {
    const option = roleOptions[i];
    const button = new ButtonBuilder()
      .setCustomId(`${ROLE_MENU_BUTTON_PREFIX}${menuId}:${option.roleId}`)
      .setLabel(option.label)
      .setStyle(option.style);

    if (option.emoji) {
      button.setEmoji(parseComponentEmoji(option.emoji));
    }

    currentRow.addComponents(button);
    if (currentRow.components.length === 5 || i === roleOptions.length - 1) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }

  return rows;
}

function buildRoleMenuMessageContent(config) {
  const lines = [`**${config.title}**`, config.description, ''];
  if (config.singleSelect) {
    lines.push('_Only one role from this menu can be selected at a time._', '');
  }
  for (const option of config.roleOptions) {
    const prefix = option.emoji ? `${option.emoji} ` : '• ';
    lines.push(`${prefix}<@&${option.roleId}>`);
  }
  return lines.join('\n');
}

async function publishRoleMenuMessage(client, guildId, options = null) {
  const config = getRoleMenuSettings(guildId);
  if (!config.enabled) {
    throw Object.assign(new Error('Role menu is disabled. Enable it before publishing.'), { status: 400 });
  }
  const publishConfig = options && typeof options === 'object' ? {
    menuId: normalizeString(options.menuId),
    menuChannelId: normalizeRoleId(options.menuChannelId) || config.menuChannelId,
    title: normalizeString(options.title) || config.title,
    description: normalizeString(options.description) || config.description,
    singleSelect: normalizeBoolean(options.singleSelect, config.singleSelect),
    roleOptions: Array.isArray(options.roleOptions)
      ? parseRoleOptions({ roleOptions: options.roleOptions })
      : config.roleOptions,
  } : {
    menuId: null,
    menuChannelId: config.menuChannelId,
    title: config.title,
    description: config.description,
    singleSelect: config.singleSelect,
    roleOptions: config.roleOptions,
  };

  if (!publishConfig.menuChannelId) {
    throw Object.assign(new Error('Missing role menu channel in setup wizard.'), { status: 400 });
  }
  if (!publishConfig.roleOptions.length) {
    throw Object.assign(new Error('Add at least one role option before publishing.'), { status: 400 });
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    throw Object.assign(new Error('Guild not found in bot cache.'), { status: 404 });
  }

  const channel = await guild.channels.fetch(publishConfig.menuChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw Object.assign(new Error('Configured role menu channel is not a text channel.'), { status: 400 });
  }

  const existingMenu = publishConfig.menuId
    ? config.roleMenus.find((menu) => menu.menuId === publishConfig.menuId) || null
    : null;
  const menuId = existingMenu?.menuId || `menu_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const publishedMenu = {
    menuId,
    menuChannelId: publishConfig.menuChannelId,
    title: publishConfig.title,
    description: publishConfig.description,
    singleSelect: publishConfig.singleSelect,
    roleOptions: publishConfig.roleOptions,
  };

  let message = null;
  if (existingMenu?.messageId) {
    const existingChannel = await guild.channels.fetch(existingMenu.menuChannelId).catch(() => null);
    if (existingChannel?.isTextBased()) {
      const existingMessage = await existingChannel.messages.fetch(existingMenu.messageId).catch(() => null);
      if (existingMessage) {
        message = await existingMessage.edit({
          content: buildRoleMenuMessageContent(publishedMenu),
          components: buildRoleMenuComponents(publishedMenu.roleOptions, menuId),
        });
      }
    }
  }

  if (!message) {
    message = await channel.send({
      content: buildRoleMenuMessageContent(publishedMenu),
      components: buildRoleMenuComponents(publishedMenu.roleOptions, menuId),
    });
  }

  const nextRoleMenus = [
    ...config.roleMenus.filter((menu) => menu.menuId !== menuId && menu.messageId !== message.id),
    { ...publishedMenu, messageId: message.id },
  ].slice(-MAX_STORED_ROLE_MENUS);

  const updatedExtra = {
    ...config.extra,
    menuChannelId: publishConfig.menuChannelId,
    title: publishConfig.title,
    description: publishConfig.description,
    singleSelect: publishConfig.singleSelect,
    roleOptions: publishConfig.roleOptions.map((option) => ({
      roleId: option.roleId,
      label: option.label,
      emoji: option.emoji,
      style: Object.keys(BUTTON_STYLE_MAP).find((key) => BUTTON_STYLE_MAP[key] === option.style) || 'secondary',
    })),
    roleMenuMessageId: message.id,
    roleMenus: nextRoleMenus.map((menu) => ({
      menuId: menu.menuId,
      messageId: menu.messageId,
        menuChannelId: menu.menuChannelId,
        title: menu.title,
        description: menu.description,
        singleSelect: !!menu.singleSelect,
        roleOptions: menu.roleOptions.map((option) => ({
          roleId: option.roleId,
          label: option.label,
          emoji: option.emoji,
        style: Object.keys(BUTTON_STYLE_MAP).find((key) => BUTTON_STYLE_MAP[key] === option.style) || 'secondary',
      })),
    })),
  };

  settingsRepo.setFeature(guildId, ROLE_MENU_FEATURE_ID, true, config.channelIds, updatedExtra);
  return {
    channelId: message.channelId,
    messageId: message.id,
    menuId,
    roleMenus: nextRoleMenus,
  };
}

async function handleRoleMenuButton(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith(ROLE_MENU_BUTTON_PREFIX)) {
    return false;
  }
  if (!interaction.guildId || !interaction.member) return false;

  const rawToken = interaction.customId.slice(ROLE_MENU_BUTTON_PREFIX.length);
  const firstColon = rawToken.indexOf(':');
  const hasMenuId = firstColon > 0;
  const menuId = hasMenuId ? rawToken.slice(0, firstColon) : null;
  const roleId = hasMenuId ? rawToken.slice(firstColon + 1) : rawToken;
  if (!roleId) return false;

  const config = getRoleMenuSettings(interaction.guildId);
  if (!config.enabled) {
    await interaction.reply({
      content: 'This role menu is currently disabled by server admins.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  let menuConfig = null;
  if (menuId) {
    menuConfig = config.roleMenus.find((menu) => menu.menuId === menuId) || null;
  }

  if (!menuConfig && interaction.message?.id) {
    menuConfig = config.roleMenus.find((menu) => menu.messageId === interaction.message.id) || null;
  }

  if (!menuConfig && interaction.channelId) {
    menuConfig = config.roleMenus.find((menu) =>
      menu.menuChannelId === interaction.channelId &&
      menu.roleOptions.some((option) => option.roleId === roleId),
    ) || null;
  }

  if (!menuConfig && config.roleOptions.length) {
    menuConfig = {
      singleSelect: config.singleSelect,
      roleOptions: config.roleOptions,
    };
  }

  const selectedRoleOption = menuConfig?.roleOptions?.find((option) => option.roleId === roleId) || null;
  if (!selectedRoleOption) {
    await interaction.reply({
      content: 'That role is no longer configured in the role menu.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const channelAllowed = !config.channelIds || config.channelIds.includes(interaction.channelId);
  if (!channelAllowed) {
    await interaction.reply({
      content: 'This role menu button is not active in this channel.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const me = interaction.guild.members.me;
  if (!me || !me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    await interaction.reply({
      content: 'I need the **Manage Roles** permission to update roles.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
  if (!role) {
    await interaction.reply({
      content: 'That role no longer exists.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const isEveryoneRole = role.id === interaction.guild.id;
  if (role.managed || isEveryoneRole) {
    await interaction.reply({
      content: 'That role cannot be self-assigned.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (me.roles.highest.comparePositionTo(role) <= 0) {
    await interaction.reply({
      content: 'I can’t assign that role because it is above my highest role.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  let member = interaction.member && interaction.member.roles?.cache ? interaction.member : null;
  if (!member) {
    member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  }
  if (!member) {
    await interaction.reply({
      content: 'Could not resolve your server membership.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const memberHasRole = member.roles.cache.has(role.id);
  try {
    if (memberHasRole) {
      await member.roles.remove(role.id, 'Role menu self-unassign');
      await interaction.reply({
        content: `Removed role **${role.name}**.`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      if (menuConfig?.singleSelect) {
        const otherRoleIds = menuConfig.roleOptions
          .map((option) => option.roleId)
          .filter((candidateId) => candidateId !== role.id && member.roles.cache.has(candidateId));
        for (const otherRoleId of otherRoleIds) {
          const otherRole = await interaction.guild.roles.fetch(otherRoleId).catch(() => null);
          if (!otherRole) continue;
          const otherIsEveryone = otherRole.id === interaction.guild.id;
          if (otherRole.managed || otherIsEveryone) continue;
          if (me.roles.highest.comparePositionTo(otherRole) <= 0) {
            await interaction.reply({
              content: `I can’t remove **${otherRole.name}**, so I can’t enforce single-role selection for this menu.`,
              flags: MessageFlags.Ephemeral,
            });
            return true;
          }
          await member.roles.remove(otherRole.id, 'Role menu single-select replace');
        }
      }
      await member.roles.add(role.id, 'Role menu self-assign');
      await interaction.reply({
        content: `Added role **${role.name}**.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  } catch (err) {
    console.error('[RoleMenu] Button handler failed:', err);
    await interaction.reply({
      content: 'Failed to update your role. Please contact an admin.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
  }

  return true;
}

module.exports = {
  ROLE_MENU_FEATURE_ID,
  getRoleMenuSettings,
  publishRoleMenuMessage,
  handleRoleMenuButton,
};
