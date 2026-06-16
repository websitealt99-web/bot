'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  CASINO BOT  —  Production Ready
// ═══════════════════════════════════════════════════════════════════════════════

const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ── CLIENT ────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ═══════════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const PREFIX = '!';
const SUPERSLOTS_BASE_CD    = 20_000;
const SUPERSLOTS_FAST_CD    = 5_000;
const ANNOUNCEMENT_THRESHOLD = 500_000;   // coins — announce wins above this
const JACKPOT_THRESHOLD      = 1_000_000;
const MIN_BET = 1;
const MAX_BET = 50_000_000;

const COLORS = {
  gold:    '#FFD700',
  green:   '#2ECC71',
  red:     '#E74C3C',
  blue:    '#3498DB',
  purple:  '#9B59B6',
  cyan:    '#1ABC9C',
  orange:  '#E67E22',
  dark:    '#2C2F33',
  diamond: '#00FFFF',
};

const DIVIDER = '━━━━━━━━━━━━━━━━━━━━━━';

// ── DAILY STREAK REWARDS ──────────────────────────────────────────────────────
const DAILY_REWARDS = [500, 600, 750, 900, 1_100, 1_350, 1_650, 2_000, 2_500, 3_000];
const dailyReward = (streak) => DAILY_REWARDS[Math.min(streak - 1, DAILY_REWARDS.length - 1)];

// ── SHOP ITEMS ────────────────────────────────────────────────────────────────
const SHOP_ITEMS = {
  fastcooldown: {
    id: 'fastcooldown',
    emoji: '⚡',
    name: 'Fast Cooldown',
    desc: 'Reduces Super Slots cooldown from 20s → 5s permanently.',
    price: 10_000_000,
    type: 'permanent',
    flag: 'hasFastCooldown',
  },
  gambler: {
    id: 'gambler',
    emoji: '🎩',
    name: 'Gambler\'s Hat',
    desc: 'All winnings multiplied by 1.1× permanently.',
    price: 50_000_000,
    type: 'permanent',
    flag: 'hasGamblerRole',
  },
  risktoken: {
    id: 'risktoken',
    emoji: '🔥',
    name: 'Risk Token',
    desc: 'Consumable. 5× your next BJ or Roulette win OR loss.',
    price: 2_500_000,
    type: 'consumable',
    flag: 'riskTokens',
  },
  luckycharm: {
    id: 'luckycharm',
    emoji: '🍀',
    name: 'Lucky Charm',
    desc: 'Consumable. +5% payout bonus on your next Slots or Super Slots spin.',
    price: 1_000_000,
    type: 'consumable',
    flag: 'luckyCharms',
  },
  vip: {
    id: 'vip',
    emoji: '💎',
    name: 'VIP Membership',
    desc: '+2% bonus on ALL wins permanently.',
    price: 100_000_000,
    type: 'permanent',
    flag: 'hasVIP',
  },
  jackpotticket: {
    id: 'jackpotticket',
    emoji: '🎟️',
    name: 'Jackpot Ticket',
    desc: 'Consumable. Doubles Super Slots jackpot multiplier on next spin.',
    price: 5_000_000,
    type: 'consumable',
    flag: 'jackpotTickets',
  },
  mysterycrate: {
    id: 'mysterycrate',
    emoji: '📦',
    name: 'Mystery Crate',
    desc: 'Consumable. Open for a random reward (coins, tokens, charms).',
    price: 750_000,
    type: 'consumable',
    flag: 'mysteryCrates',
  },
};

// ── ACHIEVEMENTS ──────────────────────────────────────────────────────────────
const ACHIEVEMENTS = {
  first_win:      { id: 'first_win',      emoji: '🏅', name: 'First Win',       desc: 'Win your first game.',              condition: (u) => u.gamesWon >= 1 },
  wins_10:        { id: 'wins_10',        emoji: '🎯', name: 'Sharp Shooter',   desc: 'Win 10 games.',                     condition: (u) => u.gamesWon >= 10 },
  wins_100:       { id: 'wins_100',       emoji: '🔥', name: 'On Fire',         desc: 'Win 100 games.',                    condition: (u) => u.gamesWon >= 100 },
  wins_1000:      { id: 'wins_1000',      emoji: '👑', name: 'Legend',          desc: 'Win 1,000 games.',                  condition: (u) => u.gamesWon >= 1_000 },
  millionaire:    { id: 'millionaire',    emoji: '💰', name: 'Millionaire',     desc: 'Reach a balance of 1,000,000.',     condition: (u) => u.balance >= 1_000_000 },
  high_roller:    { id: 'high_roller',    emoji: '💸', name: 'High Roller',     desc: 'Win 100,000+ coins in one game.',   condition: (u) => u.biggestWin >= 100_000 },
  whale:          { id: 'whale',          emoji: '🐋', name: 'Whale',           desc: 'Win 1,000,000+ coins in one game.', condition: (u) => u.biggestWin >= 1_000_000 },
  risk_taker:     { id: 'risk_taker',     emoji: '🎲', name: 'Risk Taker',      desc: 'Use a Risk Token.',                 condition: (u) => u.riskTokensUsed >= 1 },
  daily_7:        { id: 'daily_7',        emoji: '📅', name: 'Weekly Grinder',  desc: 'Maintain a 7-day daily streak.',    condition: (u) => u.bestDailyStreak >= 7 },
  daily_30:       { id: 'daily_30',       emoji: '🗓️', name: 'Dedicated',       desc: 'Maintain a 30-day daily streak.',   condition: (u) => u.bestDailyStreak >= 30 },
  streak_5:       { id: 'streak_5',       emoji: '⚡', name: 'Win Streak',      desc: 'Win 5 games in a row.',             condition: (u) => u.bestWinStreak >= 5 },
  streak_20:      { id: 'streak_20',      emoji: '🌩️', name: 'Unstoppable',     desc: 'Win 20 games in a row.',            condition: (u) => u.bestWinStreak >= 20 },
  jackpot_hit:    { id: 'jackpot_hit',    emoji: '🎰', name: 'Jackpot!',        desc: 'Hit a slots jackpot.',              condition: (u) => u.jackpotsHit >= 1 },
  vip_club:       { id: 'vip_club',       emoji: '💎', name: 'VIP Club',        desc: 'Purchase VIP Membership.',          condition: (u) => u.hasVIP === 1 },
  big_spender:    { id: 'big_spender',    emoji: '🛍️', name: 'Big Spender',    desc: 'Spend 10,000,000 coins in shop.',   condition: (u) => u.totalShopSpent >= 10_000_000 },
};

// ═══════════════════════════════════════════════════════════════════════════════
//  DATABASE
// ═══════════════════════════════════════════════════════════════════════════════

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'casino.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userId            TEXT PRIMARY KEY,
    balance           INTEGER NOT NULL DEFAULT 1000,
    totalWon          INTEGER NOT NULL DEFAULT 0,
    totalLost         INTEGER NOT NULL DEFAULT 0,
    gamesPlayed       INTEGER NOT NULL DEFAULT 0,
    gamesWon          INTEGER NOT NULL DEFAULT 0,
    gamesLost         INTEGER NOT NULL DEFAULT 0,
    biggestWin        INTEGER NOT NULL DEFAULT 0,
    winStreak         INTEGER NOT NULL DEFAULT 0,
    bestWinStreak     INTEGER NOT NULL DEFAULT 0,
    dailyStreak       INTEGER NOT NULL DEFAULT 0,
    bestDailyStreak   INTEGER NOT NULL DEFAULT 0,
    lastDaily         INTEGER NOT NULL DEFAULT 0,
    lastSuperSlots    INTEGER NOT NULL DEFAULT 0,
    hasGamblerRole    INTEGER NOT NULL DEFAULT 0,
    hasFastCooldown   INTEGER NOT NULL DEFAULT 0,
    hasVIP            INTEGER NOT NULL DEFAULT 0,
    riskTokens        INTEGER NOT NULL DEFAULT 0,
    luckyCharms       INTEGER NOT NULL DEFAULT 0,
    jackpotTickets    INTEGER NOT NULL DEFAULT 0,
    mysteryCrates     INTEGER NOT NULL DEFAULT 0,
    riskTokensUsed    INTEGER NOT NULL DEFAULT 0,
    jackpotsHit       INTEGER NOT NULL DEFAULT 0,
    totalShopSpent    INTEGER NOT NULL DEFAULT 0,
    achievementsUnlocked TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS announcements (
    channelId TEXT
  );
`);

// Migrations — safely add new columns to existing DBs
const existingCols = db.prepare(`PRAGMA table_info(users)`).all().map(r => r.name);
const neededCols = {
  hasVIP:           'INTEGER NOT NULL DEFAULT 0',
  luckyCharms:      'INTEGER NOT NULL DEFAULT 0',
  jackpotTickets:   'INTEGER NOT NULL DEFAULT 0',
  mysteryCrates:    'INTEGER NOT NULL DEFAULT 0',
  riskTokensUsed:   'INTEGER NOT NULL DEFAULT 0',
  jackpotsHit:      'INTEGER NOT NULL DEFAULT 0',
  totalShopSpent:   'INTEGER NOT NULL DEFAULT 0',
  gamesPlayed:      'INTEGER NOT NULL DEFAULT 0',
  gamesWon:         'INTEGER NOT NULL DEFAULT 0',
  gamesLost:        'INTEGER NOT NULL DEFAULT 0',
  biggestWin:       'INTEGER NOT NULL DEFAULT 0',
  winStreak:        'INTEGER NOT NULL DEFAULT 0',
  bestWinStreak:    'INTEGER NOT NULL DEFAULT 0',
  dailyStreak:      'INTEGER NOT NULL DEFAULT 0',
  bestDailyStreak:  'INTEGER NOT NULL DEFAULT 0',
};
for (const [col, def] of Object.entries(neededCols)) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
  }
}

// ── DB HELPERS ────────────────────────────────────────────────────────────────
const stmtGetUser  = db.prepare(`SELECT * FROM users WHERE userId = ?`);
const stmtInsert   = db.prepare(`INSERT OR IGNORE INTO users (userId) VALUES (?)`);
const stmtSaveUser = db.prepare(`
  UPDATE users SET
    balance=@balance, totalWon=@totalWon, totalLost=@totalLost,
    gamesPlayed=@gamesPlayed, gamesWon=@gamesWon, gamesLost=@gamesLost,
    biggestWin=@biggestWin, winStreak=@winStreak, bestWinStreak=@bestWinStreak,
    dailyStreak=@dailyStreak, bestDailyStreak=@bestDailyStreak,
    lastDaily=@lastDaily, lastSuperSlots=@lastSuperSlots,
    hasGamblerRole=@hasGamblerRole, hasFastCooldown=@hasFastCooldown, hasVIP=@hasVIP,
    riskTokens=@riskTokens, luckyCharms=@luckyCharms,
    jackpotTickets=@jackpotTickets, mysteryCrates=@mysteryCrates,
    riskTokensUsed=@riskTokensUsed, jackpotsHit=@jackpotsHit,
    totalShopSpent=@totalShopSpent,
    achievementsUnlocked=@achievementsUnlocked
  WHERE userId = @userId
`);

function getUser(userId) {
  stmtInsert.run(userId);
  return stmtGetUser.get(userId);
}

function saveUser(user) {
  if (typeof user.achievementsUnlocked !== 'string') {
    user.achievementsUnlocked = JSON.stringify(user.achievementsUnlocked || []);
  }
  stmtSaveUser.run(user);
}

function updateBalance(user, amount) {
  user.balance += amount;
  if (amount > 0) user.totalWon += amount;
  else user.totalLost += Math.abs(amount);
  return user;
}

const txSaveUser = db.transaction((user) => saveUser(user));

function getAchievements(user) {
  try { return JSON.parse(user.achievementsUnlocked); }
  catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ECONOMY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function applyBonusMultiplier(user, amount) {
  if (amount <= 0) return amount;
  let mult = 1;
  if (user.hasGamblerRole) mult *= 1.1;
  if (user.hasVIP)         mult *= 1.02;
  return Math.floor(amount * mult);
}

function fmt(n) { return Math.abs(n).toLocaleString(); }
function fmtSigned(n) { return n >= 0 ? `+${fmt(n)}` : `-${fmt(n)}`; }

function recordGameResult(user, won, netProfit) {
  user.gamesPlayed++;
  if (won) {
    user.gamesWon++;
    user.winStreak++;
    if (user.winStreak > user.bestWinStreak) user.bestWinStreak = user.winStreak;
    if (netProfit > user.biggestWin) user.biggestWin = netProfit;
  } else {
    user.gamesLost++;
    user.winStreak = 0;
  }
  return user;
}

// ── ANNOUNCEMENT CHANNEL ──────────────────────────────────────────────────────
let announcementChannelId = null;
try {
  const row = db.prepare(`SELECT channelId FROM announcements LIMIT 1`).get();
  if (row) announcementChannelId = row.channelId;
} catch {}

async function announce(text) {
  if (!announcementChannelId) return;
  const ch = client.channels.cache.get(announcementChannelId);
  if (!ch) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setDescription(text)
    .setTimestamp();
  ch.send({ embeds: [embed] }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACHIEVEMENT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

async function checkAchievements(user, message) {
  const unlocked = getAchievements(user);
  const newlyUnlocked = [];

  for (const ach of Object.values(ACHIEVEMENTS)) {
    if (!unlocked.includes(ach.id) && ach.condition(user)) {
      unlocked.push(ach.id);
      newlyUnlocked.push(ach);
      user.achievementsUnlocked = JSON.stringify(unlocked);
    }
  }

  if (newlyUnlocked.length > 0) {
    txSaveUser(user);
    for (const ach of newlyUnlocked) {
      const embed = new EmbedBuilder()
        .setColor(COLORS.gold)
        .setTitle(`${ach.emoji} Achievement Unlocked!`)
        .setDescription(`**${message.author.username}** earned **${ach.name}**\n\n*${ach.desc}*`)
        .setThumbnail(message.author.displayAvatarURL())
        .setTimestamp();
      message.channel.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACTIVE GAME TRACKING
// ═══════════════════════════════════════════════════════════════════════════════

const activeGames   = new Map(); // gameId -> gameState
const activeUsers   = new Set(); // userId -> has active BJ game
const armedRisk     = new Map(); // userId -> true
const armedCharm    = new Map(); // userId -> true

// ═══════════════════════════════════════════════════════════════════════════════
//  CARD UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SUITS  = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_COLOR = { '♠': '', '♣': '', '♥': '❤', '♦': '♦' };

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const v of VALUES) deck.push({ s, v });
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardValue(card) {
  if (['J', 'Q', 'K'].includes(card.v)) return 10;
  if (card.v === 'A') return 11;
  return parseInt(card.v);
}

function handValue(hand) {
  let total = hand.reduce((s, c) => s + cardValue(c), 0);
  let aces  = hand.filter(c => c.v === 'A').length;
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function formatCard(c) {
  const suitEmoji = { '♠': '♠️', '♥': '♥️', '♦': '♦️', '♣': '♣️' };
  return `**${c.v}${suitEmoji[c.s] || c.s}**`;
}

function formatHand(hand) { return hand.map(formatCard).join('  '); }

// ═══════════════════════════════════════════════════════════════════════════════
//  SLOT UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

const SLOT_SYMBOLS  = ['🍒', '🍋', '🍊', '🍇', '⭐', '🔔', '💰', '7️⃣', '💎'];
const SLOT_WEIGHTS  = [  28,   24,   20,   14,    7,    4,    2,    1,    0.2];
const SLOT_TOTAL    = SLOT_WEIGHTS.reduce((a, b) => a + b, 0);

function weightedSlot() {
  let r = Math.random() * SLOT_TOTAL;
  for (let i = 0; i < SLOT_SYMBOLS.length; i++) {
    r -= SLOT_WEIGHTS[i];
    if (r <= 0) return SLOT_SYMBOLS[i];
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

const SLOT_MULTIPLIERS = {
  '🍒': { two: 2,  three: 5   },
  '🍋': { two: 2,  three: 6   },
  '🍊': { two: 3,  three: 8   },
  '🍇': { two: 3,  three: 10  },
  '⭐': { two: 5,  three: 20  },
  '🔔': { two: 5,  three: 25  },
  '💰': { two: 8,  three: 40  },
  '7️⃣': { two: 15, three: 100 },
  '💎': { two: 25, three: 200 },
};

// ── SUPER SLOTS ───────────────────────────────────────────────────────────────
const SS_SYMBOLS = ['🍒', '🍋', '🍊', '🍇', '⭐', '🔔', '💰', '7️⃣', '👑'];
const SS_ROW_MULTIPLIERS = [0, 1, 3, 8, 25, 100, 500, 5_000];
const SS_DIAMOND_BONUS   = 1_000;
const SS_DIAMOND_CHANCE  = 0.008; // 0.8% per row

// ═══════════════════════════════════════════════════════════════════════════════
//  SHOP BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function buildShopEmbed(user, page = 0) {
  const items     = Object.values(SHOP_ITEMS);
  const pageSize  = 4;
  const pages     = Math.ceil(items.length / pageSize);
  const slice     = items.slice(page * pageSize, page * pageSize + pageSize);

  const lines = slice.map(item => {
    const owned  = item.type === 'permanent'
      ? (user[item.flag] ? '✅ **OWNED**' : null)
      : `📦 Owned: **${user[item.flag] || 0}**`;
    const price  = `🪙 **${item.price.toLocaleString()}** coins`;
    const status = owned || price;
    return [
      `${item.emoji} **${item.name}**  —  ${price}`,
      `> ${item.desc}`,
      `> ${status}`,
      '',
    ].join('\n');
  });

  return new EmbedBuilder()
    .setColor(COLORS.purple)
    .setTitle('🛒  Casino Shop')
    .setDescription(
      `**Your Balance:** 🪙 ${user.balance.toLocaleString()} coins\n` +
      `${DIVIDER}\n\n` +
      lines.join('\n') +
      `${DIVIDER}\n*Page ${page + 1} of ${pages}*`
    )
    .setFooter({ text: 'Use the buttons below to browse and purchase.' });
}

function buildShopComponents(user, page = 0, qty = 1) {
  const items    = Object.values(SHOP_ITEMS);
  const pageSize = 4;
  const pages    = Math.ceil(items.length / pageSize);
  const slice    = items.slice(page * pageSize, page * pageSize + pageSize);

  const buyButtons = slice.map(item => {
    const disabled = item.type === 'permanent' && user[item.flag];
    return new ButtonBuilder()
      .setCustomId(`shop_buy_${item.id}`)
      .setLabel(disabled ? `${item.name} ✅` : `${item.name}`)
      .setEmoji(item.emoji)
      .setStyle(disabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(!!disabled);
  });

  const row1 = new ActionRowBuilder().addComponents(...buyButtons);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_page_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('shop_qty_minus').setLabel('−').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shop_qty_show').setLabel(`Qty: ${qty}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('shop_qty_plus').setLabel('+').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shop_page_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_arm_risk')
      .setLabel('🔥 Arm Risk Token')
      .setStyle(armedRisk.get(user.userId) ? ButtonStyle.Success : ButtonStyle.Danger)
      .setDisabled(!user.riskTokens || armedRisk.get(user.userId)),
    new ButtonBuilder()
      .setCustomId('shop_arm_charm')
      .setLabel('🍀 Arm Lucky Charm')
      .setStyle(armedCharm.get(user.userId) ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!user.luckyCharms || armedCharm.get(user.userId)),
    new ButtonBuilder()
      .setCustomId('shop_open_crate')
      .setLabel('📦 Open Crate')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!user.mysteryCrates),
  );

  return [row1, row2, row3];
}

const shopSessions = new Map(); // userId -> { page, qty }

function attachShopCollector(msg, ownerId) {
  shopSessions.set(ownerId, { page: 0, qty: 1 });
  const collector = msg.createMessageComponentCollector({ time: 120_000 });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: '❌ Open your own shop with `!shop`.', ephemeral: true });
    }

    let user = getUser(ownerId);
    const sess = shopSessions.get(ownerId) || { page: 0, qty: 1 };

    const { customId } = interaction;

    if (customId === 'shop_page_prev') {
      sess.page = Math.max(0, sess.page - 1);
      shopSessions.set(ownerId, sess);
      return interaction.update({ embeds: [buildShopEmbed(user, sess.page)], components: buildShopComponents(user, sess.page, sess.qty) });
    }
    if (customId === 'shop_page_next') {
      const maxPage = Math.ceil(Object.keys(SHOP_ITEMS).length / 4) - 1;
      sess.page = Math.min(maxPage, sess.page + 1);
      shopSessions.set(ownerId, sess);
      return interaction.update({ embeds: [buildShopEmbed(user, sess.page)], components: buildShopComponents(user, sess.page, sess.qty) });
    }
    if (customId === 'shop_qty_minus') {
      sess.qty = Math.max(1, sess.qty - 1);
      shopSessions.set(ownerId, sess);
      return interaction.update({ embeds: [buildShopEmbed(user, sess.page)], components: buildShopComponents(user, sess.page, sess.qty) });
    }
    if (customId === 'shop_qty_plus') {
      sess.qty = Math.min(99, sess.qty + 1);
      shopSessions.set(ownerId, sess);
      return interaction.update({ embeds: [buildShopEmbed(user, sess.page)], components: buildShopComponents(user, sess.page, sess.qty) });
    }

    if (customId === 'shop_arm_risk') {
      if (!user.riskTokens) return interaction.reply({ content: '❌ No Risk Tokens.', ephemeral: true });
      if (armedRisk.get(ownerId)) return interaction.reply({ content: '⚠️ Already armed.', ephemeral: true });
      armedRisk.set(ownerId, true);
      await interaction.reply({ content: '🔥 **Risk Token armed!** Your next BJ/Roulette win or loss is multiplied by **5×**.', ephemeral: true });
      user = getUser(ownerId);
      return interaction.message.edit({ embeds: [buildShopEmbed(user, sess.page)], components: buildShopComponents(user, sess.page, sess.qty) });
    }

    if (customId === 'shop_arm_charm') {
      if (!user.luckyCharms) return interaction.reply({ content: '❌ No Lucky Charms.', ephemeral: true });
      if (armedCharm.get(ownerId)) return interaction.reply({ content: '⚠️ Already armed.', ephemeral: true });
      armedCharm.set(ownerId, true);
      await interaction.reply({ content: '🍀 **Lucky Charm armed!** Your next Slots/Super Slots spin has +5% payout.', ephemeral: true });
      user = getUser(ownerId);
      return interaction.message.edit({ embeds: [buildShopEmbed(user, sess.page)], components: buildShopComponents(user, sess.page, sess.qty) });
    }

    if (customId === 'shop_open_crate') {
      if (!user.mysteryCrates) return interaction.reply({ content: '❌ No Mystery Crates.', ephemeral: true });
      user.mysteryCrates -= 1;
      const roll = Math.random();
      let reward, rewardText;
      if (roll < 0.05) {
        reward = 5_000_000; user.balance += reward; user.totalWon += reward;
        rewardText = `💰 **JACKPOT!** You got **${reward.toLocaleString()} coins**!`;
      } else if (roll < 0.15) {
        user.riskTokens += 3;
        rewardText = `🔥 You got **3× Risk Tokens**!`;
      } else if (roll < 0.35) {
        reward = 500_000; user.balance += reward; user.totalWon += reward;
        rewardText = `💵 You got **${reward.toLocaleString()} coins**!`;
      } else if (roll < 0.6) {
        user.luckyCharms += 2;
        rewardText = `🍀 You got **2× Lucky Charms**!`;
      } else {
        reward = 100_000; user.balance += reward; user.totalWon += reward;
        rewardText = `🪙 You got **${reward.toLocaleString()} coins**.`;
      }
      txSaveUser(user);
      await interaction.reply({ content: `📦 **Mystery Crate opened!**\n${rewardText}`, ephemeral: true });
      user = getUser(ownerId);
      return interaction.message.edit({ embeds: [buildShopEmbed(user, sess.page)], components: buildShopComponents(user, sess.page, sess.qty) });
    }

    // Buy buttons
    if (customId.startsWith('shop_buy_')) {
      const itemId = customId.replace('shop_buy_', '');
      const item   = SHOP_ITEMS[itemId];
      if (!item) return interaction.reply({ content: '❌ Unknown item.', ephemeral: true });

      const qty   = item.type === 'consumable' ? sess.qty : 1;
      const total = item.price * qty;

      if (item.type === 'permanent' && user[item.flag]) {
        return interaction.reply({ content: `❌ You already own **${item.emoji} ${item.name}**.`, ephemeral: true });
      }
      if (user.balance < total) {
        return interaction.reply({ content: `❌ You need **${total.toLocaleString()}** coins but have **${user.balance.toLocaleString()}**.`, ephemeral: true });
      }

      user.balance -= total;
      user.totalShopSpent += total;
      if (item.type === 'permanent') user[item.flag] = 1;
      else user[item.flag] = (user[item.flag] || 0) + qty;

      txSaveUser(user);
      await interaction.reply({
        content: `✅ Purchased **${qty > 1 ? `${qty}× ` : ''}${item.emoji} ${item.name}**!\n> Spent: **${total.toLocaleString()} coins**`,
        ephemeral: true,
      });
      user = getUser(ownerId);
      return interaction.message.edit({ embeds: [buildShopEmbed(user, sess.page)], components: buildShopComponents(user, sess.page, sess.qty) });
    }
  });

  collector.on('end', () => {
    shopSessions.delete(ownerId);
    msg.edit({ components: [] }).catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BLACKJACK
// ═══════════════════════════════════════════════════════════════════════════════

function buildBJEmbed(playerHand, dealerHand, bet, riskTag, showDealer = false, status = null, color = COLORS.gold) {
  const pVal = handValue(playerHand);
  const dVal = handValue(dealerHand);
  const dDisplay = showDealer
    ? `${formatHand(dealerHand)}\n**Total: ${dVal}**`
    : `${formatCard(dealerHand[0])}  🂠\n**Total: ?**`;

  let desc =
    `${DIVIDER}\n` +
    `👤  **PLAYER**\n${formatHand(playerHand)}\n**Total: ${pVal}**\n` +
    `${DIVIDER}\n` +
    `🎩  **DEALER**\n${dDisplay}\n` +
    `${DIVIDER}\n` +
    `🪙  **Bet: ${bet.toLocaleString()} coins**`;

  if (riskTag) desc += `\n${riskTag}`;
  if (status) desc += `\n\n${status}`;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle('🃏  BLACKJACK')
    .setDescription(desc);
}

async function startBlackjack(message, bet, user) {
  const userId = message.author.id;

  const riskActive = !!armedRisk.get(userId);
  let riskConsumed = false;
  if (riskActive && user.riskTokens > 0) {
    user.riskTokens     -= 1;
    user.riskTokensUsed += 1;
    riskConsumed = true;
    armedRisk.delete(userId);
  } else if (riskActive) {
    armedRisk.delete(userId);
  }
  const riskMulti = riskConsumed ? 5 : 1;
  const riskTag   = riskConsumed ? '🔥 **5× RISK TOKEN ACTIVE** — win or lose, it\'s 5×!' : null;

  user.balance -= bet;
  user.totalLost += bet;
  txSaveUser(user);

  const deck       = buildDeck();
  const playerHand = [deck.pop(), deck.pop()];
  const dealerHand = [deck.pop(), deck.pop()];
  const pVal       = handValue(playerHand);
  const gameId     = `bj_${userId}_${Date.now()}`;

  // Natural blackjack
  if (pVal === 21) {
    activeUsers.delete(userId);
    let winnings = applyBonusMultiplier(user, Math.floor(bet * 2.5 * riskMulti));
    user.totalLost   -= bet;
    user.balance     += winnings;
    user.totalWon    += winnings;
    user = recordGameResult(user, true, winnings - bet);
    txSaveUser(user);
    await checkAchievements(user, message);
    if (winnings - bet >= ANNOUNCEMENT_THRESHOLD) {
      announce(`🃏 **${message.author.username}** hit a **Natural Blackjack** and won **${(winnings - bet).toLocaleString()} coins**! 🎉`);
    }
    const embed = buildBJEmbed(playerHand, dealerHand, bet, riskTag, true,
      `🎉 **NATURAL BLACKJACK!**\n💰 You won **+${(winnings - bet).toLocaleString()} coins** (2.5×)`, COLORS.green);
    return message.reply({ embeds: [embed] });
  }

  activeGames.set(gameId, { deck, playerHand, dealerHand, bet, userId, riskMulti, riskTag });

  const embed = buildBJEmbed(playerHand, dealerHand, bet, riskTag, false,
    '*Hit or Stand?*  ·  Auto-stand in 60s');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bj_hit_${gameId}`).setLabel('HIT').setStyle(ButtonStyle.Primary).setEmoji('👊'),
    new ButtonBuilder().setCustomId(`bj_stand_${gameId}`).setLabel('STAND').setStyle(ButtonStyle.Secondary).setEmoji('✋'),
  );

  const msg = await message.reply({ embeds: [embed], components: [row] });

  const collector = msg.createMessageComponentCollector({ time: 60_000 });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: '❌ This isn\'t your game!', ephemeral: true });
    }
    const game = activeGames.get(gameId);
    if (!game) return;

    if (interaction.customId === `bj_hit_${gameId}`) {
      game.playerHand.push(game.deck.pop());
      const newVal = handValue(game.playerHand);

      if (newVal > 21) {
        activeGames.delete(gameId);
        activeUsers.delete(userId);
        collector.stop('resolved');

        let freshUser = getUser(userId);
        const extraLoss = game.bet * (game.riskMulti - 1);
        if (extraLoss > 0) { freshUser.balance -= extraLoss; freshUser.totalLost += extraLoss; }
        freshUser = recordGameResult(freshUser, false, 0);
        txSaveUser(freshUser);

        const loseEmbed = buildBJEmbed(game.playerHand, game.dealerHand, game.bet, game.riskTag, true,
          `💥 **BUST!** Total: ${newVal}\n💸 You lost **${(game.bet * game.riskMulti).toLocaleString()} coins**`, COLORS.red);
        return interaction.update({ embeds: [loseEmbed], components: [] });
      }

      if (newVal === 21) {
        // Auto-resolve stand at 21
        return handleStand(interaction, game, gameId, userId, collector);
      }

      const hitEmbed = buildBJEmbed(game.playerHand, game.dealerHand, game.bet, game.riskTag, false, '*Hit or Stand?*');
      return interaction.update({ embeds: [hitEmbed], components: [row] });
    }

    if (interaction.customId === `bj_stand_${gameId}`) {
      return handleStand(interaction, game, gameId, userId, collector);
    }
  });

  collector.on('end', (_, reason) => {
    if (reason !== 'resolved' && activeGames.has(gameId)) {
      // Auto-stand on timeout
      const game = activeGames.get(gameId);
      if (!game) return;
      handleStandTimeout(msg, game, gameId, userId);
    }
  });
}

async function handleStand(interaction, game, gameId, userId, collector) {
  while (handValue(game.dealerHand) < 17) game.dealerHand.push(game.deck.pop());
  const pFinal = handValue(game.playerHand);
  const dFinal = handValue(game.dealerHand);
  activeGames.delete(gameId);
  activeUsers.delete(userId);
  if (collector) collector.stop('resolved');

  let freshUser = getUser(userId);
  let color, statusText;

  if (dFinal > 21 || pFinal > dFinal) {
    let winnings = applyBonusMultiplier(freshUser, Math.floor(game.bet * 2 * game.riskMulti));
    freshUser.balance     += winnings;
    freshUser.totalWon    += winnings;
    freshUser.totalLost   -= game.bet;
    freshUser = recordGameResult(freshUser, true, winnings - game.bet);
    color = COLORS.green;
    statusText = `🏆 **YOU WIN!**\n💰 +**${(winnings - game.bet).toLocaleString()} coins**`;
    if (winnings - game.bet >= ANNOUNCEMENT_THRESHOLD) {
      announce(`🃏 **${interaction.user.username}** won **${(winnings - game.bet).toLocaleString()} coins** in Blackjack! 🔥`);
    }
  } else if (pFinal === dFinal) {
    freshUser.balance   += game.bet;
    freshUser.totalLost -= game.bet;
    color = COLORS.gold;
    statusText = `🤝 **PUSH!** Bet returned: **${game.bet.toLocaleString()} coins**`;
  } else {
    const extraLoss = game.bet * (game.riskMulti - 1);
    if (extraLoss > 0) { freshUser.balance -= extraLoss; freshUser.totalLost += extraLoss; }
    freshUser = recordGameResult(freshUser, false, 0);
    color = COLORS.red;
    statusText = `💀 **DEALER WINS!**\n💸 -**${(game.bet * game.riskMulti).toLocaleString()} coins**`;
  }

  txSaveUser(freshUser);
  if (interaction) await checkAchievements(freshUser, { author: interaction.user, channel: interaction.channel });

  const finalEmbed = buildBJEmbed(game.playerHand, game.dealerHand, game.bet, game.riskTag, true, statusText, color);
  return interaction
    ? interaction.update({ embeds: [finalEmbed], components: [] })
    : null;
}

async function handleStandTimeout(msg, game, gameId, userId) {
  activeGames.delete(gameId);
  activeUsers.delete(userId);
  while (handValue(game.dealerHand) < 17) game.dealerHand.push(game.deck.pop());
  const pFinal = handValue(game.playerHand);
  const dFinal = handValue(game.dealerHand);
  let freshUser = getUser(userId);
  let color, statusText;

  if (dFinal > 21 || pFinal > dFinal) {
    let winnings = applyBonusMultiplier(freshUser, Math.floor(game.bet * 2 * game.riskMulti));
    freshUser.balance   += winnings;
    freshUser.totalWon  += winnings;
    freshUser.totalLost -= game.bet;
    freshUser = recordGameResult(freshUser, true, winnings - game.bet);
    color = COLORS.green;
    statusText = `🏆 **AUTO-STAND: YOU WIN!**\n💰 +**${(winnings - game.bet).toLocaleString()} coins**`;
  } else if (pFinal === dFinal) {
    freshUser.balance   += game.bet;
    freshUser.totalLost -= game.bet;
    color = COLORS.gold;
    statusText = `🤝 **AUTO-STAND: PUSH!** Bet returned.`;
  } else {
    const extraLoss = game.bet * (game.riskMulti - 1);
    if (extraLoss > 0) { freshUser.balance -= extraLoss; freshUser.totalLost += extraLoss; }
    freshUser = recordGameResult(freshUser, false, 0);
    color = COLORS.red;
    statusText = `⏱️ **TIME UP — AUTO-STAND — DEALER WINS!**\n💸 -**${(game.bet * game.riskMulti).toLocaleString()} coins**`;
  }

  txSaveUser(freshUser);
  const finalEmbed = buildBJEmbed(game.playerHand, game.dealerHand, game.bet, game.riskTag, true, statusText, color);
  msg.edit({ embeds: [finalEmbed], components: [] }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROULETTE
// ═══════════════════════════════════════════════════════════════════════════════

const ROULETTE_OPTIONS = {
  red:   { emoji: '🔴', label: 'Red',   prob: 0.45, payout: 2  },
  black: { emoji: '⚫', label: 'Black', prob: 0.45, payout: 2  },
  green: { emoji: '💚', label: 'Green', prob: 0.10, payout: 10 },
};
const ROULETTE_ALIASES = { r: 'red', b: 'black', g: 'green' };

function spinRoulette() {
  const r = Math.random();
  if (r < 0.45) return 'red';
  if (r < 0.90) return 'black';
  return 'green';
}

async function playRoulette(message, betStr, colorStr) {
  const userId = message.author.id;
  const bet    = parseInt(betStr);

  if (isNaN(bet) || bet < MIN_BET || bet > MAX_BET) {
    return message.reply(`❌ Usage: \`!roulette <color> <bet>\`\nBet must be between **${MIN_BET.toLocaleString()}** and **${MAX_BET.toLocaleString()}**.`);
  }

  const normalised = ROULETTE_ALIASES[colorStr?.toLowerCase()] || colorStr?.toLowerCase();
  if (!ROULETTE_OPTIONS[normalised]) {
    return message.reply('❌ Choose a color: `red` (r), `black` (b), or `green` (g).\nExample: `!roulette red 1000`');
  }

  const user = getUser(userId);
  if (user.balance < bet) return message.reply(`❌ You only have **${user.balance.toLocaleString()} coins**.`);

  const riskActive = !!armedRisk.get(userId);
  let riskConsumed = false;
  if (riskActive && user.riskTokens > 0) {
    user.riskTokens     -= 1;
    user.riskTokensUsed += 1;
    riskConsumed = true;
    armedRisk.delete(userId);
  } else if (riskActive) {
    armedRisk.delete(userId);
  }
  const riskMulti = riskConsumed ? 5 : 1;

  user.balance -= bet;
  user.totalLost += bet;
  txSaveUser(user);

  const pick   = ROULETTE_OPTIONS[normalised];
  const result = spinRoulette();
  const landed = ROULETTE_OPTIONS[result];

  // Spinning animation
  const spinningEmbed = new EmbedBuilder()
    .setColor(COLORS.orange)
    .setTitle('🎡  ROULETTE')
    .setDescription(
      `${DIVIDER}\n` +
      `🎯  **Your Pick**\n${pick.emoji}  ${pick.label}\n` +
      `${DIVIDER}\n` +
      `🌀  **Spinning...**\n` +
      `${DIVIDER}\n` +
      `🪙  **Bet: ${bet.toLocaleString()} coins**` +
      (riskConsumed ? '\n🔥 **5× RISK TOKEN ACTIVE**' : '')
    );

  const msg = await message.reply({ embeds: [spinningEmbed] });
  await new Promise(r => setTimeout(r, 1_500));

  const won = result === normalised;
  let freshUser = getUser(userId);
  let netText, color, resultLine;

  if (won) {
    let winnings = applyBonusMultiplier(freshUser, Math.floor(bet * pick.payout * riskMulti));
    freshUser.balance   += winnings;
    freshUser.totalWon  += winnings;
    freshUser.totalLost -= bet;
    freshUser = recordGameResult(freshUser, true, winnings - bet);
    color      = COLORS.green;
    resultLine = `✅ **WIN!**  ${fmtSigned(winnings - bet)} coins`;
    netText    = `+**${(winnings - bet).toLocaleString()}**`;
    if (winnings - bet >= ANNOUNCEMENT_THRESHOLD) {
      announce(`🎡 **${message.author.username}** spun **${landed.emoji} ${landed.label}** in Roulette and won **${(winnings - bet).toLocaleString()} coins**!`);
    }
  } else {
    const extraLoss = bet * (riskMulti - 1);
    if (extraLoss > 0) { freshUser.balance -= extraLoss; freshUser.totalLost += extraLoss; }
    freshUser = recordGameResult(freshUser, false, 0);
    const totalLost = bet * riskMulti;
    color      = COLORS.red;
    resultLine = `❌ **LOSE**  −${totalLost.toLocaleString()} coins`;
    netText    = `-**${totalLost.toLocaleString()}**`;
  }

  txSaveUser(freshUser);
  await checkAchievements(freshUser, message);

  const finalEmbed = new EmbedBuilder()
    .setColor(color)
    .setTitle('🎡  ROULETTE')
    .setDescription(
      `${DIVIDER}\n` +
      `🎯  **Your Pick**\n${pick.emoji}  ${pick.label}\n` +
      `${DIVIDER}\n` +
      `🎡  **Wheel Landed On**\n${landed.emoji}  ${landed.label}\n` +
      `${DIVIDER}\n` +
      `${resultLine}\n` +
      `🪙  **Net: ${netText} coins**` +
      (riskConsumed ? '\n🔥 **5× Risk Token used**' : '') +
      `\n${DIVIDER}\n` +
      `💰  Balance: **${freshUser.balance.toLocaleString()}** coins`
    );

  msg.edit({ embeds: [finalEmbed] }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SLOTS
// ═══════════════════════════════════════════════════════════════════════════════

async function playSlots(message, betStr) {
  const userId = message.author.id;
  const bet    = parseInt(betStr);

  if (isNaN(bet) || bet < MIN_BET || bet > MAX_BET) {
    return message.reply(`❌ Usage: \`!slots <bet>\`  (1 – ${MAX_BET.toLocaleString()})`);
  }

  const user = getUser(userId);
  if (user.balance < bet) return message.reply(`❌ You only have **${user.balance.toLocaleString()} coins**.`);

  const charmActive = !!armedCharm.get(userId);
  if (charmActive) armedCharm.delete(userId);
  const charmMult = charmActive ? 1.05 : 1;
  if (charmActive && user.luckyCharms > 0) { user.luckyCharms -= 1; txSaveUser(user); }

  user.balance -= bet;
  user.totalLost += bet;

  const reels = [weightedSlot(), weightedSlot(), weightedSlot()];
  let multiplier = 0, resultLine = '';

  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    multiplier = SLOT_MULTIPLIERS[reels[0]]?.three || 5;
    if (reels[0] === '7️⃣') {
      resultLine = '🎰 **JACKPOT! TRIPLE 7s!**';
      user.jackpotsHit = (user.jackpotsHit || 0) + 1;
    } else if (reels[0] === '💎') {
      resultLine = '💎 **TRIPLE DIAMONDS!**';
    } else {
      resultLine = `🎉 **TRIPLE ${reels[0]}!**`;
    }
  } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
    const match  = reels[0] === reels[1] ? reels[0] : reels[2];
    multiplier   = SLOT_MULTIPLIERS[match]?.two || 2;
    resultLine   = `✨ **TWO ${match}!**`;
  } else {
    resultLine = '💔 No match — try again!';
  }

  let winnings = 0, freshUser;
  let won = multiplier > 0;

  if (won) {
    winnings = Math.floor(bet * multiplier * charmMult);
    freshUser = getUser(userId);
    winnings  = applyBonusMultiplier(freshUser, winnings);
    freshUser.balance   += winnings;
    freshUser.totalWon  += winnings;
    freshUser.totalLost -= bet;
    freshUser = recordGameResult(freshUser, true, winnings - bet);
  } else {
    freshUser = getUser(userId);
    freshUser = recordGameResult(freshUser, false, 0);
  }

  txSaveUser(freshUser);
  await checkAchievements(freshUser, message);

  const net = winnings - bet;

  const embed = new EmbedBuilder()
    .setColor(won ? COLORS.gold : COLORS.red)
    .setTitle('🎰  SLOTS')
    .setDescription(
      `${DIVIDER}\n` +
      `[ ${reels.join('  ')} ]\n` +
      `${DIVIDER}\n` +
      `${resultLine}` +
      (multiplier > 0 ? `  (**${multiplier}×**)` : '') +
      (charmActive ? '\n🍀 Lucky Charm: +5% payout' : '') +
      `\n\n🪙 **Bet:** ${bet.toLocaleString()}\n` +
      `💰 **Net:** ${net >= 0 ? '+' : ''}**${net.toLocaleString()}** coins\n` +
      `${DIVIDER}\n` +
      `Balance: **${freshUser.balance.toLocaleString()}** coins`
    );

  if (won && winnings - bet >= ANNOUNCEMENT_THRESHOLD) {
    announce(`🎰 **${message.author.username}** won **${(winnings - bet).toLocaleString()} coins** in Slots! 🎉`);
  }
  if (reels[0] === reels[1] && reels[1] === reels[2] && reels[0] === '7️⃣') {
    announce(`🎰🎊 **${message.author.username}** hit the **JACKPOT** in Slots — Triple 7s worth **${(winnings - bet).toLocaleString()} coins**!!!`);
  }

  return message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SUPER SLOTS
// ═══════════════════════════════════════════════════════════════════════════════

async function playSuperSlots(message, betStr) {
  const userId = message.author.id;
  const bet    = parseInt(betStr);

  if (isNaN(bet) || bet < MIN_BET || bet > MAX_BET) {
    return message.reply(`❌ Usage: \`!superslots <bet>\`  (1 – ${MAX_BET.toLocaleString()})`);
  }

  const user = getUser(userId);
  if (user.balance < bet) return message.reply(`❌ You only have **${user.balance.toLocaleString()} coins**.`);

  const cdLength = user.hasFastCooldown ? SUPERSLOTS_FAST_CD : SUPERSLOTS_BASE_CD;
  const now      = Date.now();
  const elapsed  = now - (user.lastSuperSlots || 0);
  if (elapsed < cdLength) {
    const secs = ((cdLength - elapsed) / 1000).toFixed(1);
    return message.reply(`⏳ Super Slots on cooldown! **${secs}s** remaining.${!user.hasFastCooldown ? ' Buy ⚡ Fast Cooldown in `!shop` to cut this to 5s!' : ''}`);
  }

  const charmActive   = !!armedCharm.get(userId);
  const ticketActive  = user.jackpotTickets > 0 && Math.random() < 0.3;
  if (charmActive) armedCharm.delete(userId);

  user.lastSuperSlots = now;
  user.balance        -= bet;
  user.totalLost      += bet;
  if (charmActive && user.luckyCharms > 0) user.luckyCharms -= 1;
  if (ticketActive) user.jackpotTickets -= 1;
  txSaveUser(user);

  const ROWS = 7;
  const COLS = 3;
  const grid = [];

  for (let r = 0; r < ROWS; r++) {
    if (Math.random() < SS_DIAMOND_CHANCE) {
      grid.push(['💎', '💎', '💎']);
    } else {
      const sym = SS_SYMBOLS[Math.floor(Math.random() * SS_SYMBOLS.length)];
      const row = Array.from({ length: COLS }, () =>
        Math.random() < 0.30 ? sym : SS_SYMBOLS[Math.floor(Math.random() * SS_SYMBOLS.length)]
      );
      grid.push(row);
    }
  }

  let winningRows  = 0;
  let diamondRows  = 0;

  for (const row of grid) {
    if (row.every(s => s === row[0])) {
      if (row[0] === '💎') diamondRows++;
      else winningRows++;
    }
  }

  const baseMultiplier  = SS_ROW_MULTIPLIERS[Math.min(winningRows, 7)];
  const diamondBonus    = diamondRows * SS_DIAMOND_BONUS * (ticketActive ? 2 : 1);
  const charmBonus      = charmActive ? 1.05 : 1;
  const totalMultiplier = baseMultiplier + diamondBonus;

  let winnings = 0, freshUser;
  const won = totalMultiplier > 0;

  if (won) {
    winnings = Math.floor(bet * totalMultiplier * charmBonus);
    freshUser = getUser(userId);
    winnings  = applyBonusMultiplier(freshUser, winnings);
    freshUser.balance   += winnings;
    freshUser.totalWon  += winnings;
    freshUser.totalLost -= bet;
    freshUser = recordGameResult(freshUser, true, winnings - bet);
    if (diamondRows > 0) freshUser.jackpotsHit = (freshUser.jackpotsHit || 0) + 1;
  } else {
    freshUser = getUser(userId);
    freshUser = recordGameResult(freshUser, false, 0);
  }

  txSaveUser(freshUser);
  await checkAchievements(freshUser, message);

  const net = winnings - bet;

  const gridText = grid.map(row => {
    const win    = row.every(s => s === row[0]);
    const isDiam = win && row[0] === '💎';
    const marker = isDiam ? '💎' : win ? '✅' : '▫️';
    return `${marker}  ${row.join('  ')}`;
  }).join('\n');

  let resultSection = '';
  if (!won) {
    resultSection = '😔 No winning rows this time.';
  } else {
    if (winningRows > 0) resultSection += `🎰 **${winningRows} winning row${winningRows > 1 ? 's' : ''}** → **${baseMultiplier}×**\n`;
    if (diamondRows  > 0) resultSection += `💎 **${diamondRows} DIAMOND row${diamondRows > 1 ? 's' : ''}** → +**${diamondBonus}× BONUS**${ticketActive ? ' ×2 (Ticket!)' : ''}\n`;
    resultSection += `⚡ Total multiplier: **${totalMultiplier}×**`;
    if (charmActive) resultSection += `\n🍀 Lucky Charm: +5%`;
  }

  const embed = new EmbedBuilder()
    .setColor(won ? (diamondRows > 0 ? COLORS.diamond : COLORS.gold) : COLORS.red)
    .setTitle('💎  SUPER SLOTS  —  7 × 3')
    .setDescription(
      `${DIVIDER}\n\`\`\`\n${gridText}\n\`\`\`\n${DIVIDER}\n` +
      `${resultSection}\n\n` +
      `🪙 **Bet:** ${bet.toLocaleString()}\n` +
      `💰 **Net:** ${net >= 0 ? '+' : ''}**${net.toLocaleString()}** coins\n` +
      `${DIVIDER}\n` +
      `Balance: **${freshUser.balance.toLocaleString()}** coins`
    )
    .setFooter({ text: `✅ = winning row  |  💎 = diamond row (+${SS_DIAMOND_BONUS.toLocaleString()}× bonus)  |  CD: ${cdLength / 1000}s` });

  if (won && winnings - bet >= ANNOUNCEMENT_THRESHOLD) {
    announce(`💎 **${message.author.username}** hit **${totalMultiplier}×** in Super Slots and won **${(winnings - bet).toLocaleString()} coins**! 🎊`);
  }
  if (diamondRows > 0) {
    announce(`💎💎 **${message.author.username}** landed a **DIAMOND ROW** in Super Slots — **${(winnings - bet).toLocaleString()} coins**!!! 🤯`);
  }

  return message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════════

async function showLeaderboard(message) {
  const rows = db.prepare(`SELECT userId, balance FROM users ORDER BY balance DESC LIMIT 10`).all();

  const medals = ['🥇', '🥈', '🥉'];
  const lines  = await Promise.all(rows.map(async (row, i) => {
    let name;
    try {
      const member = await message.guild.members.fetch(row.userId);
      name = member.displayName;
    } catch {
      name = `User#${row.userId.slice(-4)}`;
    }
    const medal = medals[i] || `**${i + 1}.**`;
    return `${medal}  ${name}\n> 🪙 **${row.balance.toLocaleString()}** coins`;
  }));

  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('🏆  LEADERBOARD  —  Top 10 Richest')
    .setDescription(`${DIVIDER}\n${lines.join(`\n${DIVIDER}\n`)}\n${DIVIDER}`)
    .setTimestamp();
  return message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

function buildProfileEmbed(user, member) {
  const unlocked    = getAchievements(user);
  const totalGames  = user.gamesPlayed || 1;
  const winRate     = ((user.gamesWon / totalGames) * 100).toFixed(1);
  const netPnl      = user.totalWon - user.totalLost;

  const upgrades = [
    user.hasGamblerRole  ? '🎩 Gambler\'s Hat'   : null,
    user.hasFastCooldown ? '⚡ Fast Cooldown'     : null,
    user.hasVIP          ? '💎 VIP Membership'    : null,
  ].filter(Boolean).join('\n') || '*None*';

  const inventory = [
    user.riskTokens      ? `🔥 Risk Tokens: **${user.riskTokens}**`       : null,
    user.luckyCharms     ? `🍀 Lucky Charms: **${user.luckyCharms}**`      : null,
    user.jackpotTickets  ? `🎟️ Jackpot Tickets: **${user.jackpotTickets}**` : null,
    user.mysteryCrates   ? `📦 Mystery Crates: **${user.mysteryCrates}**`  : null,
  ].filter(Boolean).join('\n') || '*Empty*';

  return new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle(`🎰  ${member.displayName}'s Profile`)
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(
      `${DIVIDER}\n` +
      `💰 **Balance**\n> **${user.balance.toLocaleString()}** coins\n` +
      `${DIVIDER}\n` +
      `📊 **Stats**\n` +
      `> Games Played: **${user.gamesPlayed.toLocaleString()}**\n` +
      `> Wins / Losses: **${user.gamesWon.toLocaleString()}** / **${user.gamesLost.toLocaleString()}**\n` +
      `> Win Rate: **${winRate}%**\n` +
      `> Biggest Win: **${user.biggestWin.toLocaleString()}** coins\n` +
      `> Best Win Streak: **${user.bestWinStreak}**\n` +
      `> Net P&L: **${netPnl >= 0 ? '+' : ''}${netPnl.toLocaleString()}** coins\n` +
      `${DIVIDER}\n` +
      `📅 **Daily Streak**\n> Current: **${user.dailyStreak}** days  |  Best: **${user.bestDailyStreak}** days\n` +
      `${DIVIDER}\n` +
      `🏅 **Achievements** (${unlocked.length}/${Object.keys(ACHIEVEMENTS).length})\n` +
      `> ${unlocked.slice(0, 6).map(id => ACHIEVEMENTS[id]?.emoji || '🏅').join('  ') || '*None yet*'}\n` +
      `${DIVIDER}\n` +
      `🛍️ **Upgrades**\n> ${upgrades}\n` +
      `${DIVIDER}\n` +
      `🎒 **Inventory**\n> ${inventory}\n` +
      `${DIVIDER}`
    )
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════════════════════════════════════

function buildInventoryEmbed(user, memberName) {
  const consumables = [
    { emoji: '🔥', label: 'Risk Tokens',     count: user.riskTokens,     armed: armedRisk.get(user.userId) },
    { emoji: '🍀', label: 'Lucky Charms',    count: user.luckyCharms,    armed: armedCharm.get(user.userId) },
    { emoji: '🎟️', label: 'Jackpot Tickets', count: user.jackpotTickets, armed: false },
    { emoji: '📦', label: 'Mystery Crates',  count: user.mysteryCrates,  armed: false },
  ];

  const permanents = [
    { emoji: '🎩', label: "Gambler's Hat",    owned: user.hasGamblerRole  },
    { emoji: '⚡', label: 'Fast Cooldown',    owned: user.hasFastCooldown },
    { emoji: '💎', label: 'VIP Membership',   owned: user.hasVIP          },
  ];

  const consLines = consumables.map(c =>
    `${c.emoji}  **${c.label}:** ${c.count || 0}${c.armed ? '  *(Armed ✅)*' : ''}`
  ).join('\n');

  const permLines = permanents.map(p =>
    `${p.emoji}  **${p.label}:** ${p.owned ? '✅ Owned' : '❌ Not owned'}`
  ).join('\n');

  return new EmbedBuilder()
    .setColor(COLORS.cyan)
    .setTitle(`🎒  ${memberName}'s Inventory`)
    .setDescription(
      `${DIVIDER}\n` +
      `🧪 **Consumables**\n${consLines}\n` +
      `${DIVIDER}\n` +
      `⭐ **Permanent Upgrades**\n${permLines}\n` +
      `${DIVIDER}\n` +
      `*Use \`!shop\` to buy more items  |  \`!arm\` to arm tokens*`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════════════════════

function buildStatsEmbed(user, memberName) {
  const totalGames = user.gamesPlayed || 1;
  const winRate    = ((user.gamesWon / totalGames) * 100).toFixed(1);
  const netPnl     = user.totalWon - user.totalLost;

  return new EmbedBuilder()
    .setColor(COLORS.blue)
    .setTitle(`📊  ${memberName}'s Statistics`)
    .setDescription(
      `${DIVIDER}\n` +
      `🎮 **Games**\n` +
      `> Played: **${user.gamesPlayed.toLocaleString()}**\n` +
      `> Won: **${user.gamesWon.toLocaleString()}**\n` +
      `> Lost: **${user.gamesLost.toLocaleString()}**\n` +
      `> Win Rate: **${winRate}%**\n` +
      `${DIVIDER}\n` +
      `💰 **Economy**\n` +
      `> Total Won: **${user.totalWon.toLocaleString()}** coins\n` +
      `> Total Lost: **${user.totalLost.toLocaleString()}** coins\n` +
      `> Net P&L: **${netPnl >= 0 ? '+' : ''}${netPnl.toLocaleString()}** coins\n` +
      `> Biggest Win: **${user.biggestWin.toLocaleString()}** coins\n` +
      `${DIVIDER}\n` +
      `🔥 **Streaks**\n` +
      `> Current Win Streak: **${user.winStreak}**\n` +
      `> Best Win Streak: **${user.bestWinStreak}**\n` +
      `> Daily Streak: **${user.dailyStreak}** days\n` +
      `> Best Daily Streak: **${user.bestDailyStreak}** days\n` +
      `${DIVIDER}\n` +
      `🎰 **Jackpots Hit:** **${user.jackpotsHit || 0}**\n` +
      `🔥 **Risk Tokens Used:** **${user.riskTokensUsed || 0}**\n` +
      `${DIVIDER}`
    )
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACHIEVEMENTS COMMAND
// ═══════════════════════════════════════════════════════════════════════════════

function buildAchievementsEmbed(user, memberName) {
  const unlocked = getAchievements(user);
  const lines    = Object.values(ACHIEVEMENTS).map(ach => {
    const done = unlocked.includes(ach.id);
    return `${done ? ach.emoji : '🔒'}  **${ach.name}**  ${done ? '✅' : ''}\n> *${ach.desc}*`;
  });

  return new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`🏅  ${memberName}'s Achievements  (${unlocked.length}/${Object.keys(ACHIEVEMENTS).length})`)
    .setDescription(`${DIVIDER}\n${lines.join(`\n${DIVIDER}\n`)}\n${DIVIDER}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DAILY
// ═══════════════════════════════════════════════════════════════════════════════

async function claimDaily(message) {
  const userId = message.author.id;
  const user   = getUser(userId);
  const now    = Date.now();
  const cd     = 86_400_000; // 24h

  if (now - user.lastDaily < cd) {
    const remaining = cd - (now - user.lastDaily);
    const hrs  = Math.floor(remaining / 3_600_000);
    const mins = Math.floor((remaining % 3_600_000) / 60_000);
    return message.reply(`⏳ Daily already claimed! Come back in **${hrs}h ${mins}m**.`);
  }

  // Streak logic
  const dayGap = now - user.lastDaily;
  if (dayGap <= cd * 2) {
    user.dailyStreak = (user.dailyStreak || 0) + 1;
  } else {
    user.dailyStreak = 1;
  }
  if (user.dailyStreak > (user.bestDailyStreak || 0)) user.bestDailyStreak = user.dailyStreak;

  const reward = dailyReward(user.dailyStreak);
  user.lastDaily  = now;
  user.balance   += reward;
  user.totalWon  += reward;
  txSaveUser(user);
  await checkAchievements(user, message);

  const nextReward = dailyReward(user.dailyStreak + 1);
  const embed = new EmbedBuilder()
    .setColor(COLORS.green)
    .setTitle('🎁  Daily Reward!')
    .setDescription(
      `${DIVIDER}\n` +
      `💰 You received **+${reward.toLocaleString()} coins**!\n` +
      `${DIVIDER}\n` +
      `📅 **Streak: ${user.dailyStreak} day${user.dailyStreak !== 1 ? 's' : ''}**` +
      (user.dailyStreak >= 2 ? `  🔥` : '') +
      `\n> Come back tomorrow for **+${nextReward.toLocaleString()} coins** (Day ${user.dailyStreak + 1})\n` +
      `${DIVIDER}\n` +
      `Balance: **${user.balance.toLocaleString()}** coins`
    );
  return message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BALANCE
// ═══════════════════════════════════════════════════════════════════════════════

function showBalance(message) {
  const user   = getUser(message.author.id);
  const netPnl = user.totalWon - user.totalLost;
  const embed  = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('💰  Your Balance')
    .setThumbnail(message.author.displayAvatarURL())
    .setDescription(
      `${DIVIDER}\n` +
      `🪙 **${user.balance.toLocaleString()} coins**\n` +
      `${DIVIDER}\n` +
      `📈 Won:  **${user.totalWon.toLocaleString()}**\n` +
      `📉 Lost: **${user.totalLost.toLocaleString()}**\n` +
      `💵 Net:  **${netPnl >= 0 ? '+' : ''}${netPnl.toLocaleString()}**\n` +
      `${DIVIDER}\n` +
      `🎩 Gambler's Hat: ${user.hasGamblerRole  ? '✅' : '❌'}\n` +
      `⚡ Fast Cooldown: ${user.hasFastCooldown  ? '✅' : '❌'}\n` +
      `💎 VIP:           ${user.hasVIP           ? '✅' : '❌'}\n` +
      `🔥 Risk Tokens:   **${user.riskTokens}**\n` +
      `🍀 Lucky Charms:  **${user.luckyCharms}**\n` +
      `${DIVIDER}`
    );
  return message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HELP
// ═══════════════════════════════════════════════════════════════════════════════

function showHelp(message) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.purple)
    .setTitle('🎰  Casino Bot  —  Command List')
    .setDescription(
      `${DIVIDER}\n` +
      `**💰 Economy**\n` +
      `> \`!balance\` \`!bal\` — Check your coins\n` +
      `> \`!daily\` — Claim daily coins (streak rewards!)\n` +
      `> \`!leaderboard\` \`!top\` — Top 10 richest players\n` +
      `${DIVIDER}\n` +
      `**👤 Profile**\n` +
      `> \`!profile [@user]\` — View full profile\n` +
      `> \`!stats [@user]\` — Detailed statistics\n` +
      `> \`!inventory\` — View your items\n` +
      `> \`!achievements\` — View achievements\n` +
      `${DIVIDER}\n` +
      `**🛒 Shop**\n` +
      `> \`!shop\` — Browse and buy items\n` +
      `> \`!arm\` — Arm a Risk Token\n` +
      `${DIVIDER}\n` +
      `**🃏 Games**\n` +
      `> \`!blackjack <bet>\` \`!bj\` — Blackjack (2×)\n` +
      `> \`!roulette <color> <bet>\` — Spin the wheel\n` +
      `>   Colors: \`red\`/\`r\`, \`black\`/\`b\`, \`green\`/\`g\`\n` +
      `>   Red/Black = 2×  |  Green = 10×\n` +
      `> \`!slots <bet>\` — Classic 3-reel slots\n` +
      `> \`!superslots <bet>\` \`!ss\` — 7-row mega slots\n` +
      `${DIVIDER}\n` +
      `**⚡ Super Slots Multipliers**\n` +
      `> 1 row=1×  2=3×  3=8×  4=25×  5=100×  6=500×  7=5000×\n` +
      `> 💎 Diamond row = +1000× bonus (very rare!)\n` +
      `${DIVIDER}`
    )
    .setFooter({ text: 'Good luck! 🍀  |  Bet responsibly.' });
  return message.reply({ embeds: [embed] });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PARSE BET HELPER
// ═══════════════════════════════════════════════════════════════════════════════

function parseBet(str) {
  if (!str) return NaN;
  str = str.toLowerCase().replace(/,/g, '');
  if (str.endsWith('k'))  return parseFloat(str) * 1_000;
  if (str.endsWith('m'))  return parseFloat(str) * 1_000_000;
  if (str.endsWith('b'))  return parseFloat(str) * 1_000_000_000;
  return parseInt(str);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BOT EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

client.once('ready', () => {
  console.log(`✅  ${client.user.tag} online — Casino Bot ready!`);
  client.user.setActivity('🎰 Casino  |  !help', { type: 0 });
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const raw     = message.content.slice(PREFIX.length).trim();
  const args    = raw.split(/\s+/);
  const command = args.shift().toLowerCase();
  const userId  = message.author.id;

  try {
    // ── BALANCE ──────────────────────────────────────────────────────────────
    if (command === 'balance' || command === 'bal') return showBalance(message);

    // ── DAILY ────────────────────────────────────────────────────────────────
    if (command === 'daily') return claimDaily(message);

    // ── HELP ─────────────────────────────────────────────────────────────────
    if (command === 'help') return showHelp(message);

    // ── SHOP ─────────────────────────────────────────────────────────────────
    if (command === 'shop') {
      const user = getUser(userId);
      const msg  = await message.reply({ embeds: [buildShopEmbed(user)], components: buildShopComponents(user) });
      attachShopCollector(msg, userId);
      return;
    }

    // ── ARM RISK TOKEN ────────────────────────────────────────────────────────
    if (command === 'arm' || command === 'userisk') {
      const user = getUser(userId);
      if (!user.riskTokens) return message.reply('❌ No Risk Tokens. Buy one with `!shop`.');
      if (armedRisk.get(userId)) return message.reply('⚠️ Already armed for your next BJ/Roulette round.');
      armedRisk.set(userId, true);
      const embed = new EmbedBuilder()
        .setColor(COLORS.orange)
        .setTitle('🔥  Risk Token Armed!')
        .setDescription(
          `Your next **Blackjack** or **Roulette** round will have its win/loss multiplied by **5×**.\n` +
          `Win big — or lose big.\n\n` +
          `> Tokens remaining: **${user.riskTokens - 1}**`
        );
      return message.reply({ embeds: [embed] });
    }

    // ── LEADERBOARD ───────────────────────────────────────────────────────────
    if (command === 'leaderboard' || command === 'top' || command === 'lb') {
      return showLeaderboard(message);
    }

    // ── PROFILE ───────────────────────────────────────────────────────────────
    if (command === 'profile') {
      const target  = message.mentions.users.first() || message.author;
      const member  = message.guild?.members.cache.get(target.id) || { displayName: target.username, user: target };
      const user    = getUser(target.id);
      user.userId   = target.id;
      return message.reply({ embeds: [buildProfileEmbed(user, member)] });
    }

    // ── STATS ─────────────────────────────────────────────────────────────────
    if (command === 'stats') {
      const target = message.mentions.users.first() || message.author;
      const member = message.guild?.members.cache.get(target.id) || { displayName: target.username };
      const user   = getUser(target.id);
      return message.reply({ embeds: [buildStatsEmbed(user, member.displayName || target.username)] });
    }

    // ── INVENTORY ─────────────────────────────────────────────────────────────
    if (command === 'inventory' || command === 'inv') {
      const user    = getUser(userId);
      user.userId   = userId;
      const member  = message.guild?.members.cache.get(userId);
      return message.reply({ embeds: [buildInventoryEmbed(user, member?.displayName || message.author.username)] });
    }

    // ── ACHIEVEMENTS ──────────────────────────────────────────────────────────
    if (command === 'achievements' || command === 'ach') {
      const target = message.mentions.users.first() || message.author;
      const member = message.guild?.members.cache.get(target.id);
      const user   = getUser(target.id);
      return message.reply({ embeds: [buildAchievementsEmbed(user, member?.displayName || target.username)] });
    }

    // ── BLACKJACK ─────────────────────────────────────────────────────────────
    if (command === 'blackjack' || command === 'bj') {
      if (activeUsers.has(userId)) return message.reply('⚠️ You already have an active Blackjack game! Finish it first.');
      const bet = parseBet(args[0]);
      if (isNaN(bet) || bet < MIN_BET || bet > MAX_BET) {
        return message.reply(`❌ Usage: \`!blackjack <bet>\`  (e.g. \`!bj 1000\` or \`!bj 1k\`)`);
      }
      const user = getUser(userId);
      if (user.balance < bet) return message.reply(`❌ You only have **${user.balance.toLocaleString()} coins**.`);
      activeUsers.add(userId);
      return startBlackjack(message, Math.floor(bet), user);
    }

    // ── ROULETTE ──────────────────────────────────────────────────────────────
    if (command === 'roulette' || command === 'rou') {
      return playRoulette(message, args[1], args[0]);
    }

    // ── SLOTS ─────────────────────────────────────────────────────────────────
    if (command === 'slots') {
      const bet = parseBet(args[0]);
      return playSlots(message, bet);
    }

    // ── SUPER SLOTS ───────────────────────────────────────────────────────────
    if (command === 'superslots' || command === 'ss') {
      const bet = parseBet(args[0]);
      return playSuperSlots(message, bet);
    }

    // ── SET ANNOUNCEMENT CHANNEL (admin) ──────────────────────────────────────
    if (command === 'setannouncechannel') {
      if (!message.member?.permissions.has('ManageGuild')) return;
      announcementChannelId = message.channel.id;
      db.prepare(`DELETE FROM announcements`).run();
      db.prepare(`INSERT INTO announcements (channelId) VALUES (?)`).run(message.channel.id);
      return message.reply(`✅ Announcements will be sent to this channel.`);
    }

  } catch (err) {
    console.error(`Error in command [${command}]:`, err);
    message.reply('⚠️ An error occurred. Please try again.').catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌  DISCORD_TOKEN not set. Export it before starting the bot.');
  process.exit(1);
}
client.login(TOKEN);
