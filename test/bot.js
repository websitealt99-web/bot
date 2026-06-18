'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  PREMIUM CASINO BOT  —  Single-file, Discord.js v14, Mongoose
// ═══════════════════════════════════════════════════════════════════════════════

const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const mongoose = require('mongoose');

// ── ENV ────────────────────────────────────────────────────────────────────────
// require('dotenv').config();

const TOKEN = process.env.DISCORD_TOKEN;
const MONGO = process.env.TEST_ABC_123;
const PREFIX = '!';
const JACKPOT_CHANNEL = process.env.JACKPOT_CHANNEL_ID || null;

// ── ROLE IDs ───────────────────────────────────────────────────────────────────
const ROLE_VIP     = '1234567';
const ROLE_FASTCD  = '1234567';
const ROLE_GAMBLER = '1234567';
const ROLE_LUCKY   = '1234567';

if (!TOKEN) { console.error('❌  DISCORD_TOKEN missing'); process.exit(1); }

// ═══════════════════════════════════════════════════════════════════════════════
//  MONGOOSE SCHEMA
//  Changes vs previous version:
//    + bankBalance (max 5,000,000)
//    + lastHourly
//    + lastWork
//    + favoriteGame
//    + gameCounts { blackjack, roulette, slots, superslots }
// ═══════════════════════════════════════════════════════════════════════════════

const userSchema = new mongoose.Schema({
  userId:         { type: String, required: true, unique: true, index: true },
  balance:        { type: Number, default: 1000,  min: 0 },
  bankBalance:    { type: Number, default: 0,     min: 0 },
  totalWon:       { type: Number, default: 0 },
  totalLost:      { type: Number, default: 0 },
  gamesPlayed:    { type: Number, default: 0 },
  gamesWon:       { type: Number, default: 0 },
  gamesLost:      { type: Number, default: 0 },
  biggestWin:     { type: Number, default: 0 },
  winStreak:      { type: Number, default: 0 },
  bestWinStreak:  { type: Number, default: 0 },
  dailyStreak:    { type: Number, default: 0 },
  lastDaily:      { type: Number, default: 0 },
  lastHourly:     { type: Number, default: 0 },
  lastWork:       { type: Number, default: 0 },
  lastSuperSlots: { type: Number, default: 0 },
  lastRob:        { type: Number, default: 0 },
  favoriteGame:   { type: String, default: 'None' },
  gameCounts: {
    blackjack:  { type: Number, default: 0 },
    roulette:   { type: Number, default: 0 },
    slots:      { type: Number, default: 0 },
    superslots: { type: Number, default: 0 },
  },
  inventory: {
    fastCooldown:   { type: Boolean, default: false },
    gamblerRole:    { type: Boolean, default: false },
    luckyCharm:     { type: Boolean, default: false },
    vip:            { type: Boolean, default: false },
    jackpotTickets: { type: Number,  default: 0 },
    mysteryCrates:  { type: Number,  default: 0 },
    riskTokens:     { type: Number,  default: 0 },
  },
  achievements: { type: [String], default: [] },
  flags: {
    vip:          { type: Boolean, default: false },
    gambler:      { type: Boolean, default: false },
    fastCooldown: { type: Boolean, default: false },
  },
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

// ═══════════════════════════════════════════════════════════════════════════════
//  DB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getUser(userId) {
  let u = await User.findOne({ userId });
  if (!u) u = await User.create({ userId });
  return u;
}

async function saveUser(user) {
  return user.save();
}

// Gambler multiplier: applies 1.1× to positive winnings if member has Gambler role
// member may be a GuildMember (live) or null (fallback = no bonus)
function applyGambler(member, amount) {
  if (amount > 0 && hasGambler(member))
    return Math.floor(amount * 1.1);
  return amount;
}

// Track which game is played most — updates favoriteGame field
async function trackGame(userId, gameName) {
  const field = 'gameCounts.' + gameName;
  const u = await User.findOneAndUpdate(
    { userId },
    { $inc: { [field]: 1 } },
    { new: true, upsert: false }
  );
  if (!u) return;
  const gc = u.gameCounts || {};
  const entries = [
    ['blackjack',  gc.blackjack  || 0],
    ['roulette',   gc.roulette   || 0],
    ['slots',      gc.slots      || 0],
    ['superslots', gc.superslots || 0],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const labels = {
    blackjack:  '🃏 Blackjack',
    roulette:   '🎡 Roulette',
    slots:      '🎰 Slots',
    superslots: '💎 Super Slots',
  };
  await User.updateOne({ userId }, { $set: { favoriteGame: labels[entries[0][0]] } });
}

// Record a win: update stats & achievements, save
async function recordWin(user, net) {
  user.gamesPlayed  = (user.gamesPlayed  || 0) + 1;
  user.gamesWon     = (user.gamesWon     || 0) + 1;
  user.totalWon     = (user.totalWon     || 0) + net;
  user.winStreak    = (user.winStreak    || 0) + 1;
  if (user.winStreak > (user.bestWinStreak || 0)) user.bestWinStreak = user.winStreak;
  if (net > (user.biggestWin || 0)) user.biggestWin = net;
  checkAchievements(user);
  await saveUser(user);
}

// Record a loss: update stats, reset streak, save
async function recordLoss(user, amount) {
  user.gamesPlayed = (user.gamesPlayed || 0) + 1;
  user.gamesLost   = (user.gamesLost   || 0) + 1;
  user.totalLost   = (user.totalLost   || 0) + amount;
  user.winStreak   = 0;
  checkAchievements(user);
  await saveUser(user);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACHIEVEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

const ACHIEVEMENTS = {
  FIRST_WIN:         { label: '🏅 First Win',       desc: 'Win your first game'                    },
  HIGH_ROLLER:       { label: '💸 High Roller',      desc: 'Win over 1,000,000 coins in one round'  },
  STREAK_5:          { label: '🔥 On Fire',          desc: '5-game win streak'                      },
  STREAK_10:         { label: '🌋 Unstoppable',      desc: '10-game win streak'                     },
  MILLIONAIRE:       { label: '💰 Millionaire',      desc: 'Reach 1,000,000 wallet balance'         },
  BLACKJACK_NATURAL: { label: '🃏 Natural',          desc: 'Hit a natural blackjack'                },
  DIAMOND_ROW:       { label: '💎 Diamond Luck',     desc: 'Land a Diamond row in Super Slots'      },
  DAILY_30:          { label: '📅 Dedicated',        desc: '30-day daily streak'                    },
  LUCKY_SEVEN:       { label: '7️⃣ Lucky Seven',      desc: 'Hit triple 7s in Slots'                 },
  ROULETTE_35:       { label: '🎡 Long Shot',        desc: 'Win a straight number bet in Roulette'  },
};

function checkAchievements(user) {
  const earned = new Set(user.achievements || []);
  const add = (id) => { if (!earned.has(id)) { earned.add(id); user.achievements = [...earned]; } };
  if ((user.gamesWon   || 0) >= 1)         add('FIRST_WIN');
  if ((user.biggestWin || 0) >= 1_000_000) add('HIGH_ROLLER');
  if ((user.winStreak  || 0) >= 5)         add('STREAK_5');
  if ((user.winStreak  || 0) >= 10)        add('STREAK_10');
  if ((user.balance    || 0) >= 1_000_000) add('MILLIONAIRE');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SS_BASE_CD = 20_000;     // 20 seconds
const SS_FAST_CD = 5_000;      // 5 seconds
const BANK_MAX   = 5_000_000;
const SEP        = '━━━━━━━━━━━━━━━━━━━━━━━━';

// Authorized admin user IDs for !setcredit — edit this list to add/remove admins
const ADMIN_IDS = [
  '1109145571043836024',
  '1069940476880359514',
  '719091011921379359',
];

// Rob command tuning
const ROB_COOLDOWN_MS  = 3_600_000; // 1 hour
const ROB_MIN_BALANCE  = 50_000;    // both robber & victim need at least this
const ROB_MIN_AMOUNT   = 10_000;
const ROB_MAX_AMOUNT   = 250_000;
const ROB_SUCCESS_RATE = 0.40;      // 40% success chance
const ROB_FAIL_PENALTY = 0.50;      // lose 50% of attempted amount on failure

// European roulette numbers
const ROULETTE_RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);

function rouletteColor(n) {
  if (n === 0)                 return 'green';
  if (ROULETTE_RED.has(n))     return 'red';
  return 'black';
}

// Roles (VIP, FastCD, Gambler, Lucky) are now managed by admins via Discord roles.
// Add any future purchasable non-role items here.
const SHOP_ITEMS = {};

// In-memory session maps
const activeGames = new Map(); // userId -> gameId (blocks duplicate BJ)
const bjGames     = new Map(); // gameId -> game state

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

function fmt(n)            { return Number(n).toLocaleString(); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function winRate(user) {
  const g = user.gamesPlayed || 0;
  if (!g) return '0%';
  return ((user.gamesWon / g) * 100).toFixed(1) + '%';
}

function totalProfit(user) {
  return (user.totalWon || 0) - (user.totalLost || 0);
}

function fmtCooldown(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60)  return s + 's';
  const m   = Math.floor(s / 60);
  const sec = s % 60;
  return sec > 0 ? m + 'm ' + sec + 's' : m + 'm';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROLE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function hasVIP(member)     { return !!(member && member.roles && member.roles.cache.has(ROLE_VIP));     }
function hasFastCD(member)  { return !!(member && member.roles && member.roles.cache.has(ROLE_FASTCD));  }
function hasGambler(member) { return !!(member && member.roles && member.roles.cache.has(ROLE_GAMBLER)); }
function hasLucky(member)   { return !!(member && member.roles && member.roles.cache.has(ROLE_LUCKY));   }

// ═══════════════════════════════════════════════════════════════════════════════
//  SHOP UI
// ═══════════════════════════════════════════════════════════════════════════════

function buildShopEmbed(user) {
  const items = Object.values(SHOP_ITEMS);
  const lines = items.length
    ? items.map(function(item) {
        return item.emoji + ' **' + item.name + '** — **' + fmt(item.price) + '** coins\n┗ ' + item.desc;
      }).join('\n\n')
    : '*No items currently available for purchase.*\n\nRoles (**💎 VIP**, **🎩 Gambler**, **⚡ FastCD**, **🍀 Lucky**) are granted by admins — contact staff to receive them.';

  return new EmbedBuilder()
    .setColor('#9B59B6')
    .setTitle('🛒  Casino Shop')
    .setDescription(SEP + '\n' + lines + '\n' + SEP)
    .addFields({ name: '💰 Wallet Balance', value: '**' + fmt(user.balance) + '** coins', inline: true })
    .setFooter({ text: 'Roles are managed by admins — ask staff for VIP, Gambler, FastCD, or Lucky' });
}

function buildShopRows() {
  // No purchasable items — no buttons needed
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CARDS (BLACKJACK)
// ═══════════════════════════════════════════════════════════════════════════════

function buildDeck() {
  const suits  = ['♠','♥','♦','♣'];
  const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck   = [];
  for (const s of suits) for (const v of values) deck.push({ s: s, v: v });
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
  }
  return deck;
}

function cardVal(card) {
  if (card.v === 'J' || card.v === 'Q' || card.v === 'K') return 10;
  if (card.v === 'A') return 11;
  return parseInt(card.v);
}

function handTotal(hand) {
  let t = 0;
  let aces = 0;
  for (const c of hand) {
    t += cardVal(c);
    if (c.v === 'A') aces++;
  }
  while (t > 21 && aces > 0) { t -= 10; aces--; }
  return t;
}

function fmtCard(c) { return '`' + c.v + c.s + '`'; }
function fmtHand(h) { return h.map(fmtCard).join('  '); }

// ═══════════════════════════════════════════════════════════════════════════════
//  DISCORD CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('clientReady', function() { console.log('✅  ' + client.user.tag + ' online'); });

// ═══════════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

client.on('messageCreate', async function(message) {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const raw     = message.content.slice(PREFIX.length).trim();
  const args    = raw.split(/\s+/);
  const command = args.shift().toLowerCase();
  const userId  = message.author.id;
  const author  = message.author;

  // ─────────────────────────────────────────────────────────────────────────
  //  BALANCE
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'balance' || command === 'bal') {
    const u   = await getUser(userId);
    const inv = u.inventory || {};
    const badges = [
      inv.vip          ? '💎 VIP'     : '',
      inv.gamblerRole  ? '🎩 Gambler' : '',
      inv.luckyCharm   ? '🍀 Lucky'   : '',
      inv.fastCooldown ? '⚡ FastCD'  : '',
    ].filter(Boolean).join('  ');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰  ' + author.username + "'s Balance")
      .setThumbnail(author.displayAvatarURL())
      .setDescription(badges ? badges + '\n' + SEP : SEP)
      .addFields(
        { name: '💵 Wallet',      value: '**' + fmt(u.balance) + '** coins',       inline: true },
        { name: '📈 Total Won',   value: fmt(u.totalWon) + ' coins',                inline: true },
        { name: '📉 Total Lost',  value: fmt(u.totalLost) + ' coins',               inline: true },
        { name: '🔥 Risk Tokens', value: String(inv.riskTokens || 0),               inline: true },
        { name: '🎟 Tickets',     value: String(inv.jackpotTickets || 0),            inline: true },
        { name: '📦 Crates',      value: String(inv.mysteryCrates || 0),             inline: true },
      )
      .setFooter({ text: 'Win Rate: ' + winRate(u) + '  •  Games: ' + fmt(u.gamesPlayed) + '  •  Use !bank to view bank balance' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  BANK / BANKBALANCE  (private — only the user can view, no @mentions)
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'bank' || command === 'bankbalance') {
    if (message.mentions.users.size > 0) {
      return message.reply('❌ You can only view your own bank. Usage: `!' + command + '`');
    }
    const u = await getUser(userId);
    const bank = u.bankBalance || 0;
    const remaining = Math.max(0, BANK_MAX - bank);
    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('🏦  ' + author.username + "'s Bank")
      .setThumbnail(author.displayAvatarURL())
      .setDescription(SEP)
      .addFields(
        { name: '💵 Wallet',           value: '**' + fmt(u.balance) + '** coins',  inline: true },
        { name: '🏦 Bank Balance',     value: '**' + fmt(bank) + '** coins',       inline: true },
        { name: '📦 Bank Max',         value: '**' + fmt(BANK_MAX) + '** coins',   inline: true },
        { name: '📊 Capacity Used',    value: fmt(bank) + ' / ' + fmt(BANK_MAX),   inline: true },
        { name: '✨ Remaining Space',  value: '**' + fmt(remaining) + '** coins',  inline: true },
        { name: '💡 Bank Info',
          value: 'Bank funds **cannot be gambled** — only wallet coins can.\n' +
                 'Use `!deposit` / `!withdraw` to move funds.' },
      )
      .setFooter({ text: 'Bank balance is private — only you can see this' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  DEPOSIT
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'deposit') {
    const u     = await getUser(userId);
    const bank  = u.bankBalance || 0;
    const space = BANK_MAX - bank;

    if (space <= 0)
      return message.reply('❌ Your bank is full! Maximum capacity is **' + fmt(BANK_MAX) + '** coins.');

    let amount;
    if (args[0] && args[0].toLowerCase() === 'all') {
      amount = Math.min(u.balance, space);
    } else {
      amount = parseInt(args[0]);
      if (isNaN(amount) || amount <= 0)
        return message.reply('❌ Usage: `!deposit <amount>` or `!deposit all`');
    }

    if (amount <= 0)
      return message.reply('❌ Nothing to deposit.');
    if (amount > u.balance)
      return message.reply('❌ Insufficient wallet funds. You have **' + fmt(u.balance) + '** coins.');
    if (amount > space)
      return message.reply('❌ Would exceed bank limit. You can deposit at most **' + fmt(space) + '** more coins.');

    // Atomic: deduct wallet, credit bank
    const updated = await User.findOneAndUpdate(
      { userId: userId, balance: { $gte: amount }, bankBalance: { $lte: BANK_MAX - amount } },
      { $inc: { balance: -amount, bankBalance: amount } },
      { new: true }
    );
    if (!updated)
      return message.reply('❌ Deposit failed. Check your balance and bank capacity.');

    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('🏦  Deposit Successful')
      .setDescription(SEP)
      .addFields(
        { name: '📥 Deposited',    value: '**' + fmt(amount) + '** coins',              inline: true },
        { name: '💵 Wallet',       value: '**' + fmt(updated.balance) + '** coins',     inline: true },
        { name: '🏦 Bank Balance', value: '**' + fmt(updated.bankBalance) + '** coins', inline: true },
      );
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  WITHDRAW
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'withdraw') {
    const u    = await getUser(userId);
    const bank = u.bankBalance || 0;

    if (bank <= 0)
      return message.reply('❌ Your bank is empty.');

    let amount;
    if (args[0] && args[0].toLowerCase() === 'all') {
      amount = bank;
    } else {
      amount = parseInt(args[0]);
      if (isNaN(amount) || amount <= 0)
        return message.reply('❌ Usage: `!withdraw <amount>` or `!withdraw all`');
    }

    if (amount > bank)
      return message.reply('❌ Insufficient bank funds. Bank holds **' + fmt(bank) + '** coins.');

    // Atomic: deduct bank, credit wallet
    const updated = await User.findOneAndUpdate(
      { userId: userId, bankBalance: { $gte: amount } },
      { $inc: { balance: amount, bankBalance: -amount } },
      { new: true }
    );
    if (!updated)
      return message.reply('❌ Withdrawal failed. Please try again.');

    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('🏦  Withdrawal Successful')
      .setDescription(SEP)
      .addFields(
        { name: '📤 Withdrawn',    value: '**' + fmt(amount) + '** coins',              inline: true },
        { name: '💵 Wallet',       value: '**' + fmt(updated.balance) + '** coins',     inline: true },
        { name: '🏦 Bank Balance', value: '**' + fmt(updated.bankBalance) + '** coins', inline: true },
      );
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PROFILE
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'profile') {
    const target = message.mentions.users.first() || author;
    const u      = await getUser(target.id);
    const inv    = u.inventory || {};
    const ach    = (u.achievements || []).map(function(id) {
      return ACHIEVEMENTS[id] ? ACHIEVEMENTS[id].label : id;
    }).join('\n') || '*None yet*';
    const profit = totalProfit(u);

    const badges = [
      inv.vip          ? '💎 VIP'     : null,
      inv.gamblerRole  ? '🎩 Gambler' : null,
      inv.luckyCharm   ? '🍀 Lucky'   : null,
      inv.fastCooldown ? '⚡ FastCD'  : null,
    ].filter(Boolean).join('  ') || '*No badges*';

    const embed = new EmbedBuilder()
      .setColor(inv.vip ? '#FFD700' : '#5865F2')
      .setTitle('🎰  ' + target.username + "'s Casino Profile")
      .setThumbnail(target.displayAvatarURL())
      .setDescription(badges + '\n' + SEP)
      .addFields(
        { name: '💰 Wallet',        value: '**' + fmt(u.balance) + '** coins',                            inline: true },
        { name: '🏆 Biggest Win',   value: fmt(u.biggestWin) + ' coins',                                   inline: true },
        { name: '📊 Total Profit',  value: (profit >= 0 ? '+' : '') + fmt(profit) + ' coins',              inline: true },
        { name: '🎮 Games Played',  value: fmt(u.gamesPlayed),                                             inline: true },
        { name: '✅ Games Won',      value: fmt(u.gamesWon),                                                inline: true },
        { name: '❌ Games Lost',     value: fmt(u.gamesLost),                                               inline: true },
        { name: '📈 Win Rate',       value: winRate(u),                                                     inline: true },
        { name: '🔥 Best Streak',   value: (u.bestWinStreak || 0) + ' wins',                               inline: true },
        { name: '🎯 Favorite Game', value: u.favoriteGame || 'None',                                       inline: true },
        { name: '📅 Daily Streak',  value: (u.dailyStreak || 0) + ' days',                                 inline: true },
        { name: '📈 Total Won',     value: fmt(u.totalWon) + ' coins',                                      inline: true },
        { name: '📉 Total Lost',    value: fmt(u.totalLost) + ' coins',                                     inline: true },
        { name: '🏅 Achievements (' + (u.achievements || []).length + ')', value: ach },
      )
      .setFooter({ text: 'Member since ' + new Date(u.createdAt).toDateString() + '  •  Bank balance is private' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  INVENTORY
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'inventory' || command === 'inv') {
    const u   = await getUser(userId);
    const inv = u.inventory || {};
    const lines = Object.values(SHOP_ITEMS).map(function(item) {
      if (item.type === 'permanent')
        return item.emoji + ' **' + item.name + '** — ' + (inv[item.field] ? '✅ Active' : '❌ Not owned');
      return item.emoji + ' **' + item.name + '** — **' + (inv[item.field] || 0) + '** owned';
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎒  Your Inventory')
      .setDescription(SEP + '\n' + lines + '\n' + SEP)
      .setThumbnail(author.displayAvatarURL())
      .setFooter({ text: 'Buy items with !shop' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  LEADERBOARD — richest wallet
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'leaderboard' || command === 'top' || command === 'lb') {
    const top = await User.find().sort({ balance: -1 }).limit(10).lean();
    if (!top.length) return message.reply('No players yet!');
    const medals = ['🥇','🥈','🥉'];
    let desc = SEP + '\n';
    for (let i = 0; i < top.length; i++) {
      const rank = medals[i] || ('**' + (i + 1) + '.**');
      desc += rank + '  <@' + top[i].userId + '>  —  **' + fmt(top[i].balance) + '** coins\n';
    }
    desc += SEP;
    return message.reply({ embeds: [
      new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🏆  Top 10 — Richest Players (Wallet)')
        .setDescription(desc)
        .setFooter({ text: 'Sorted by wallet balance • Bank balance excluded' }),
    ]});
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  TOPWINS — highest total winnings
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'topwins') {
    const top = await User.find().sort({ totalWon: -1 }).limit(10).lean();
    if (!top.length) return message.reply('No players yet!');
    const medals = ['🥇','🥈','🥉'];
    let desc = SEP + '\n';
    for (let i = 0; i < top.length; i++) {
      const rank = medals[i] || ('**' + (i + 1) + '.**');
      desc += rank + '  <@' + top[i].userId + '>  —  **' + fmt(top[i].totalWon) + '** coins won\n';
    }
    desc += SEP;
    return message.reply({ embeds: [
      new EmbedBuilder()
        .setColor('#00FF88')
        .setTitle('🏆  Top 10 — Highest Total Winnings')
        .setDescription(desc)
        .setFooter({ text: 'Sorted by lifetime coins won' }),
    ]});
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  TOPPROFIT — highest (totalWon - totalLost)
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'topprofit') {
    const top = await User.aggregate([
      { $addFields: { profit: { $subtract: ['$totalWon', '$totalLost'] } } },
      { $sort: { profit: -1 } },
      { $limit: 10 },
    ]);
    if (!top.length) return message.reply('No players yet!');
    const medals = ['🥇','🥈','🥉'];
    let desc = SEP + '\n';
    for (let i = 0; i < top.length; i++) {
      const p    = top[i].profit || 0;
      const rank = medals[i] || ('**' + (i + 1) + '.**');
      desc += rank + '  <@' + top[i].userId + '>  —  ' + (p >= 0 ? '+' : '') + '**' + fmt(p) + '** coins profit\n';
    }
    desc += SEP;
    return message.reply({ embeds: [
      new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle('🏆  Top 10 — Highest Overall Profit')
        .setDescription(desc)
        .setFooter({ text: 'Profit = Total Won − Total Lost' }),
    ]});
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  DAILY  — 10,000–15,000 base + streak bonus (max +10,000)
  //  Streak bonus:  Day  1–7:  +500 per day
  //                 Day  8–30: +1,000 per day
  //                 Cap: 10,000
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'daily') {
    const now = Date.now();
    const u   = await getUser(userId);
    const diff = now - (u.lastDaily || 0);

    if (diff < 86_400_000) {
      const rem  = 86_400_000 - diff;
      const hrs  = Math.floor(rem / 3_600_000);
      const mins = Math.floor((rem % 3_600_000) / 60_000);
      return message.reply('⏳ Daily already claimed! Come back in **' + hrs + 'h ' + mins + 'm**.');
    }

    // Streak continues if claimed within 48 h, otherwise resets to 1
    const newStreak = diff < 172_800_000 ? (u.dailyStreak || 0) + 1 : 1;

    // Base: random 10,000–15,000
    const base = randInt(10_000, 15_000);

    // Streak bonus calculation
    let bonus = 0;
    if (newStreak <= 7) {
      bonus = newStreak * 500;
    } else {
      bonus = 7 * 500 + (Math.min(newStreak, 30) - 7) * 1_000;
    }
    bonus = Math.min(bonus, 10_000);

    const reward = base + bonus;

    // Achievement check
    const newAch = [...(u.achievements || [])];
    if (newStreak >= 30 && !newAch.includes('DAILY_30')) newAch.push('DAILY_30');

    const updated = await User.findOneAndUpdate(
      { userId: userId },
      {
        $inc: { balance: reward, totalWon: reward },
        $set: { lastDaily: now, dailyStreak: newStreak, achievements: newAch },
      },
      { new: true }
    );

    const embed = new EmbedBuilder()
      .setColor('#00FF88')
      .setTitle('🎁  Daily Reward!')
      .setDescription(
        SEP + '\n' +
        '💵 Base reward: **' + fmt(base) + '** coins\n' +
        '🔥 Streak bonus (Day ' + newStreak + '): **+' + fmt(bonus) + '** coins\n' +
        SEP + '\n' +
        '✨ Total received: **' + fmt(reward) + '** coins\n' +
        '💰 Wallet: **' + fmt(updated.balance) + '** coins'
      )
      .setFooter({ text: 'Day ' + newStreak + ' streak  •  Day 1–7: +500/day  •  Day 8–30: +1,000/day  •  Max bonus: 10,000' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  HOURLY  — 1,000–2,000 coins, 1-hour cooldown
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'hourly') {
    const now     = Date.now();
    const CD      = 3_600_000; // 1 hour
    const u       = await getUser(userId);
    const elapsed = now - (u.lastHourly || 0);

    if (elapsed < CD) {
      const rem = CD - elapsed;
      return message.reply('⏳ Hourly on cooldown! Come back in **' + fmtCooldown(rem) + '**.');
    }

    const reward = randInt(1_000, 2_000);
    const updated = await User.findOneAndUpdate(
      { userId: userId },
      { $inc: { balance: reward, totalWon: reward }, $set: { lastHourly: now } },
      { new: true }
    );

    const nextTs = Math.floor((now + CD) / 1000);
    const embed  = new EmbedBuilder()
      .setColor('#00BFFF')
      .setTitle('⏰  Hourly Reward!')
      .setDescription(SEP)
      .addFields(
        { name: '💵 Reward',      value: '**+' + fmt(reward) + '** coins',       inline: true },
        { name: '💰 Wallet',      value: '**' + fmt(updated.balance) + '** coins', inline: true },
        { name: '⏰ Next Claim',  value: '<t:' + nextTs + ':R>',                   inline: true },
      )
      .setFooter({ text: 'Come back every hour for 1,000–2,000 coins!' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  WORK  — 500–3,000 coins, 30-minute cooldown
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'work') {
    const now     = Date.now();
    const CD      = 1_800_000; // 30 minutes
    const u       = await getUser(userId);
    const elapsed = now - (u.lastWork || 0);

    if (elapsed < CD) {
      const rem = CD - elapsed;
      return message.reply('⏳ You are still resting! Work again in **' + fmtCooldown(rem) + '**.');
    }

    const jobs = [
      { name: '💻 Programmer',       msg: 'You shipped a feature and collected your paycheck!' },
      { name: '🍳 Chef',             msg: 'You cooked up a storm and earned great tips!'        },
      { name: '🔧 Mechanic',         msg: 'You fixed some cars and got paid for your work!'     },
      { name: '🚕 Taxi Driver',      msg: 'You drove passengers all over the city!'             },
      { name: '🏗 Builder',           msg: 'You put in a hard shift on the construction site!'  },
      { name: '🌾 Farmer',           msg: 'You harvested a great crop and sold it at market!'   },
      { name: '📦 Delivery Driver',  msg: 'You delivered packages all over town on time!'       },
    ];
    const job    = jobs[Math.floor(Math.random() * jobs.length)];
    const reward = randInt(500, 3_000);

    const updated = await User.findOneAndUpdate(
      { userId: userId },
      { $inc: { balance: reward, totalWon: reward }, $set: { lastWork: now } },
      { new: true }
    );

    const nextTs = Math.floor((now + CD) / 1000);
    const embed  = new EmbedBuilder()
      .setColor('#E67E22')
      .setTitle('💼  Work Complete — ' + job.name)
      .setDescription(SEP + '\n' + job.msg + '\n' + SEP)
      .addFields(
        { name: '💵 Earned',     value: '**+' + fmt(reward) + '** coins',       inline: true },
        { name: '💰 Wallet',     value: '**' + fmt(updated.balance) + '** coins', inline: true },
        { name: '⏰ Work Again', value: '<t:' + nextTs + ':R>',                   inline: true },
      )
      .setFooter({ text: 'Cooldown: 30 minutes  •  Earn 500–3,000 coins per shift' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  GIVE  —  transfer wallet coins to another user (bank balance excluded)
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'give') {
    const target = message.mentions.users.first();
    const amount = parseInt(args[1]);

    if (!target) return message.reply('❌ Usage: `!give @user <amount>`');
    if (target.id === userId) return message.reply('❌ You cannot give coins to yourself.');
    if (target.bot) return message.reply('❌ You cannot give coins to a bot.');
    if (isNaN(amount) || amount <= 0) return message.reply('❌ Amount must be a positive number.');

    // Atomic: deduct from sender's wallet only if they can afford it
    const sender = await User.findOneAndUpdate(
      { userId: userId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true }
    );
    if (!sender) {
      const cur = await getUser(userId);
      return message.reply('❌ Insufficient wallet funds. You have **' + fmt(cur.balance) + '** coins.');
    }

    // Credit recipient's wallet (creates their doc via getUser if needed)
    await getUser(target.id);
    const recipient = await User.findOneAndUpdate(
      { userId: target.id },
      { $inc: { balance: amount } },
      { new: true }
    );

    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('🤝  Coins Transferred')
      .setDescription(SEP)
      .addFields(
        { name: '📤 From',        value: '<@' + userId + '>',                          inline: true },
        { name: '📥 To',          value: '<@' + target.id + '>',                       inline: true },
        { name: '💵 Amount',      value: '**' + fmt(amount) + '** coins',               inline: true },
        { name: '🏦 Your Wallet', value: '**' + fmt(sender.balance) + '** coins',       inline: true },
      )
      .setFooter({ text: 'Only wallet balance can be transferred — bank funds are protected' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  SETCREDIT  —  admin-only, sets a user's wallet balance directly
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'setcredit') {
    if (!ADMIN_IDS.includes(userId)) return; // silently ignore unauthorized users

    const target = message.mentions.users.first();
    const amount = parseInt(args[1]);

    if (!target) {
      return message.reply({ embeds: [
        new EmbedBuilder().setColor('#FF4444').setTitle('❌ Invalid Usage').setDescription('Usage: `!setcredit @user <amount>`'),
      ]});
    }
    if (isNaN(amount) || amount < 0) {
      return message.reply({ embeds: [
        new EmbedBuilder().setColor('#FF4444').setTitle('❌ Invalid Amount').setDescription('Amount must be a non-negative number.'),
      ]});
    }

    await getUser(target.id);
    const updated = await User.findOneAndUpdate(
      { userId: target.id },
      { $set: { balance: amount } },
      { new: true }
    );

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🛠  Wallet Balance Updated')
      .setDescription(SEP)
      .addFields(
        { name: '👤 User',       value: '<@' + target.id + '>',                  inline: true },
        { name: '💵 New Balance', value: '**' + fmt(updated.balance) + '** coins', inline: true },
        { name: '🔑 Set By',     value: '<@' + userId + '>',                      inline: true },
      )
      .setFooter({ text: 'Admin action — !setcredit' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ROB  —  attempt to steal wallet coins from another user (1h cooldown)
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'rob') {
    const target = message.mentions.users.first();
    const amount = parseInt(args[1]);

    if (!target) return message.reply('❌ Usage: `!rob @user <amount>`');
    if (target.id === userId) return message.reply('❌ You cannot rob yourself.');
    if (target.bot) return message.reply('❌ You cannot rob a bot.');
    if (isNaN(amount) || amount <= 0) return message.reply('❌ Amount must be a positive number.');
    if (amount < ROB_MIN_AMOUNT) return message.reply('❌ Minimum rob amount is **' + fmt(ROB_MIN_AMOUNT) + '** coins.');
    if (amount > ROB_MAX_AMOUNT) return message.reply('❌ Maximum rob amount is **' + fmt(ROB_MAX_AMOUNT) + '** coins.');

    const robber = await getUser(userId);
    const now    = Date.now();
    const elapsed = now - (robber.lastRob || 0);
    if (elapsed < ROB_COOLDOWN_MS) {
      const rem = ROB_COOLDOWN_MS - elapsed;
      return message.reply('⏳ Rob is on cooldown! Try again in **' + fmtCooldown(rem) + '**.');
    }

    if (robber.balance < ROB_MIN_BALANCE) {
      return message.reply('❌ You need at least **' + fmt(ROB_MIN_BALANCE) + '** wallet coins to attempt a robbery.');
    }

    const victim = await getUser(target.id);
    if (victim.balance < ROB_MIN_BALANCE) {
      return message.reply('❌ <@' + target.id + '> needs at least **' + fmt(ROB_MIN_BALANCE) + '** wallet coins to be robbed.');
    }
    if (amount > victim.balance) {
      return message.reply('❌ <@' + target.id + '> only has **' + fmt(victim.balance) + '** coins in their wallet — amount cannot exceed that.');
    }

    // Atomically claim the cooldown slot first so concurrent !rob spam can't double-fire
    const claimed = await User.findOneAndUpdate(
      { userId: userId, lastRob: robber.lastRob || 0, balance: { $gte: ROB_MIN_BALANCE } },
      { $set: { lastRob: now } },
      { new: true }
    );
    if (!claimed) {
      return message.reply('⏳ Rob is on cooldown! Try again shortly.');
    }

    const success = Math.random() < ROB_SUCCESS_RATE;

    let embed;
    if (success) {
      // Atomic transfer — only if victim still has enough wallet balance
      const victimUpdated = await User.findOneAndUpdate(
        { userId: target.id, balance: { $gte: amount } },
        { $inc: { balance: -amount } },
        { new: true }
      );
      if (!victimUpdated) {
        return message.reply('❌ <@' + target.id + '> no longer has enough coins to rob. Try again later.');
      }
      const robberUpdated = await User.findOneAndUpdate(
        { userId: userId },
        { $inc: { balance: amount, totalWon: amount } },
        { new: true }
      );
      embed = new EmbedBuilder()
        .setColor('#2ECC71')
        .setTitle('🦹  Robbery Successful!')
        .setDescription(SEP)
        .addFields(
          { name: '🎯 Target',     value: '<@' + target.id + '>',                          inline: true },
          { name: '💰 Stolen',     value: '**+' + fmt(amount) + '** coins',                 inline: true },
          { name: '🏦 Your Wallet', value: '**' + fmt(robberUpdated.balance) + '** coins',  inline: true },
        )
        .setFooter({ text: 'Bank balances are always protected from robbery' });
    } else {
      const penalty = Math.floor(amount * ROB_FAIL_PENALTY);
      const robberUpdated = await User.findOneAndUpdate(
        { userId: userId, balance: { $gte: penalty } },
        { $inc: { balance: -penalty, totalLost: penalty } },
        { new: true }
      );
      const finalBalance = robberUpdated ? robberUpdated.balance : robber.balance;
      embed = new EmbedBuilder()
        .setColor('#FF4444')
        .setTitle('🚨  Robbery Failed!')
        .setDescription(SEP)
        .addFields(
          { name: '🎯 Target',      value: '<@' + target.id + '>',           inline: true },
          { name: '💸 Penalty',     value: '**-' + fmt(penalty) + '** coins', inline: true },
          { name: '🏦 Your Wallet', value: '**' + fmt(finalBalance) + '** coins', inline: true },
        )
        .setFooter({ text: 'You got caught! 60% chance of failure each attempt' });
    }

    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  SHOP
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'shop') {
    const u   = await getUser(userId);
    const msg = await message.reply({ embeds: [buildShopEmbed(u)], components: buildShopRows(u) });
    await attachShopCollector(msg, userId);
    return;
  }


  // ─────────────────────────────────────────────────────────────────────────
  //  ARM RISK TOKEN
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'userisk' || command === 'arm') {
    const u = await getUser(userId);
    if ((u.inventory && u.inventory.riskTokens || 0) <= 0)
      return message.reply('❌ No 🔥 Risk Tokens. Buy one with `!shop`.');
    if (armedRisk.get(userId))
      return message.reply('⚠️ Already armed for next BJ or Roulette round.');
    armedRisk.set(userId, true);
    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle('🔥  Risk Token Armed!')
      .setDescription(SEP + '\nYour next **Blackjack** or **Roulette** round will multiply win/loss by **5×**.\n\nWin big — or lose big.\n' + SEP)
      .addFields({ name: '🔥 Tokens Remaining', value: String(u.inventory.riskTokens || 0) });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  OPEN MYSTERY CRATE
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'opencrate' || command === 'crate') {
    // Atomic crate deduction
    const u = await User.findOneAndUpdate(
      { userId: userId, 'inventory.mysteryCrates': { $gte: 1 } },
      { $inc: { 'inventory.mysteryCrates': -1 } },
      { new: true }
    );
    if (!u) return message.reply('❌ No 📦 Mystery Crates. Buy one with `!shop`.');

    const roll  = Math.random();
    let reward  = '';
    let color   = '#FFD700';
    let inc     = {};

    if (roll < 0.03) {
      inc    = { balance: 5_000_000, totalWon: 5_000_000 };
      reward = '💰 **JACKPOT!** You found **' + fmt(5_000_000) + '** coins!';
      color  = '#00FF00';
    } else if (roll < 0.15) {
      inc    = { 'inventory.riskTokens': 1 };
      reward = '🔥 You found a **Risk Token**!';
      color  = '#FF4500';
    } else if (roll < 0.30) {
      inc    = { 'inventory.jackpotTickets': 1 };
      reward = '🎟 You found a **Jackpot Ticket**!';
    } else if (roll < 0.55) {
      const prize = randInt(50_000, 300_000);
      inc    = { balance: prize, totalWon: prize };
      reward = '💵 You found **' + fmt(prize) + '** coins!';
    } else {
      const prize = randInt(5_000, 55_000);
      inc    = { balance: prize, totalWon: prize };
      reward = '🪙 You found **' + fmt(prize) + '** coins.';
      color  = '#888888';
    }

    const updated = await User.findOneAndUpdate({ userId: userId }, { $inc: inc }, { new: true });
    const embed   = new EmbedBuilder()
      .setColor(color)
      .setTitle('📦  Mystery Crate Opened!')
      .setDescription(SEP + '\n' + reward + '\n' + SEP)
      .addFields(
        { name: '💰 Wallet',      value: '**' + fmt(updated.balance) + '** coins',             inline: true },
        { name: '📦 Crates Left', value: String(updated.inventory.mysteryCrates),               inline: true },
      );
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  BLACKJACK
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'blackjack' || command === 'bj') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!blackjack <bet>`');
    if (activeGames.has(userId)) return message.reply('❌ You already have a Blackjack game in progress!');

    // Atomic bet deduction — fails if balance insufficient
    const u = await User.findOneAndUpdate(
      { userId: userId, balance: { $gte: bet } },
      { $inc: { balance: -bet } },
      { new: true, upsert: false }
    );
    if (!u) {
      const cur = await getUser(userId);
      return message.reply('❌ Not enough coins! You have **' + fmt(cur.balance) + '**.');
    }

    // Consume risk token if armed — atomic
    const riskActive = !!armedRisk.get(userId);
    let riskConsumed = false;
    if (riskActive) {
      const riskUp = await User.findOneAndUpdate(
        { userId: userId, 'inventory.riskTokens': { $gte: 1 } },
        { $inc: { 'inventory.riskTokens': -1 } },
        { new: true }
      );
      if (riskUp) riskConsumed = true;
      armedRisk.delete(userId);
    }
    const riskMult = riskConsumed ? 5 : 1;
    const riskTag  = riskConsumed ? '  🔥 **5× RISK**' : '';

    await trackGame(userId, 'blackjack');

    const deck       = buildDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];
    const gameId     = 'bj_' + userId + '_' + Date.now();

    activeGames.set(userId, gameId);
    bjGames.set(gameId, { deck: deck, playerHand: playerHand, dealerHand: dealerHand, bet: bet, userId: userId, riskMult: riskMult, riskConsumed: riskConsumed });

    const pVal = handTotal(playerHand);
    const dVal = handTotal(dealerHand);

    // Natural blackjack — instant resolve
    if (pVal === 21) {
      activeGames.delete(userId);
      bjGames.delete(gameId);
      const win     = applyGambler(u, Math.floor(bet * 2.5 * riskMult));
      const fresh   = await User.findOneAndUpdate(
        { userId: userId },
        { $inc: { balance: win, totalWon: win, gamesPlayed: 1, gamesWon: 1 }, $max: { biggestWin: win - bet }, $addToSet: { achievements: 'BLACKJACK_NATURAL' } },
        { new: true }
      );
      return message.reply({ embeds: [
        new EmbedBuilder()
          .setColor('#00FF88')
          .setTitle('🃏  BLACKJACK!  Natural 21!' + riskTag)
          .setDescription(SEP + '\n🎉 Natural blackjack — pays **2.5×**!\n' + SEP)
          .addFields(
            { name: '🃏 Your Hand',     value: fmtHand(playerHand) + '  =  **' + pVal + '**' },
            { name: "🎴 Dealer's Hand", value: fmtHand(dealerHand) + '  =  **' + dVal + '**' },
            { name: '💰 Winnings',      value: '**+' + fmt(win) + '** coins' },
            { name: '🏦 Wallet',        value: '**' + fmt(fresh.balance) + '** coins' },
          )
          .setFooter({ text: u.inventory && u.inventory.gamblerRole ? '🎩 Gambler 1.1× applied' : 'Play again with !blackjack' }),
      ]});
    }

    // Build initial embed helper
    function buildBJEmbed() {
      return new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🃏  Blackjack' + riskTag)
        .setDescription(SEP)
        .addFields(
          { name: '🃏 Your Hand',        value: fmtHand(playerHand) + '  =  **' + handTotal(playerHand) + '**' },
          { name: "🎴 Dealer's Visible", value: fmtCard(dealerHand[0]) + '  `??`' },
          { name: '💵 Bet',              value: fmt(bet) + ' coins' + (riskConsumed ? '  🔥 *5× risk*' : '') },
        )
        .setFooter({ text: 'Hit or Stand? (60s timeout → auto-stand)' });
    }

    const hitBtn   = new ButtonBuilder().setCustomId('bj_hit_' + gameId).setLabel('HIT').setStyle(ButtonStyle.Primary).setEmoji('👊');
    const standBtn = new ButtonBuilder().setCustomId('bj_stand_' + gameId).setLabel('STAND').setStyle(ButtonStyle.Secondary).setEmoji('✋');
    const bjRow    = new ActionRowBuilder().addComponents(hitBtn, standBtn);
    const sentMsg  = await message.reply({ embeds: [buildBJEmbed()], components: [bjRow] });

    const collector = sentMsg.createMessageComponentCollector({ time: 60_000 });

    async function resolveBJ(interaction, playerFinal, dealerFinal, game) {
      activeGames.delete(userId);
      bjGames.delete(gameId);
      collector.stop('done');

      const fresh = await getUser(userId);
      let color, title, coinsText;

      if (dealerFinal > 21 || playerFinal > dealerFinal) {
        // Player wins
        const win = applyGambler(fresh, Math.floor(bet * 2 * game.riskMult));
        await User.findOneAndUpdate(
          { userId: userId },
          { $inc: { balance: win, totalWon: win }, $max: { biggestWin: win - bet } }
        );
        fresh.balance += win;
        await recordWin(fresh, win - bet);
        color     = '#00FF88';
        title     = '🏆  You Win!' + riskTag;
        coinsText = '**+' + fmt(win) + '** coins  *(net +' + fmt(win - bet) + ')*';
      } else if (playerFinal === dealerFinal) {
        // Push
        await User.findOneAndUpdate({ userId: userId }, { $inc: { balance: bet, gamesPlayed: 1 } });
        fresh.balance += bet;
        color     = '#FFD700';
        title     = '🤝  Push! (Tie)';
        coinsText = 'Bet returned: **' + fmt(bet) + '** coins';
      } else {
        // Dealer wins
        const extra = bet * game.riskMult - bet;
        if (extra > 0) {
          await User.findOneAndUpdate(
            { userId: userId, balance: { $gte: extra } },
            { $inc: { balance: -extra, totalLost: extra } }
          );
          fresh.balance -= extra;
        }
        await recordLoss(fresh, bet * game.riskMult);
        color     = '#FF4444';
        title     = '💀  Dealer Wins!' + riskTag;
        coinsText = '-' + fmt(bet * game.riskMult) + ' coins';
      }

      const finalEmbed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(SEP)
        .addFields(
          { name: '🃏 Your Hand',     value: fmtHand(game.playerHand) + '  =  **' + playerFinal + '**' },
          { name: "🎴 Dealer's Hand", value: fmtHand(game.dealerHand) + '  =  **' + dealerFinal + '**' },
          { name: '💰 Result',        value: coinsText },
          { name: '🏦 Wallet',        value: '**' + fmt(fresh.balance) + '** coins' },
        );
      if (interaction) return interaction.update({ embeds: [finalEmbed], components: [] });
      return sentMsg.edit({ embeds: [finalEmbed], components: [] });
    }

    collector.on('collect', async function(ix) {
      if (ix.user.id !== userId)
        return ix.reply({ content: "❌ This isn't your game!", ephemeral: true });
      const game = bjGames.get(gameId);
      if (!game) return;

      if (ix.customId === 'bj_hit_' + gameId) {
        game.playerHand.push(game.deck.pop());
        const val = handTotal(game.playerHand);

        if (val > 21) {
          // Bust
          activeGames.delete(userId);
          bjGames.delete(gameId);
          collector.stop('done');
          const extra = bet * game.riskMult - bet;
          const fresh = await getUser(userId);
          if (extra > 0) {
            await User.findOneAndUpdate(
              { userId: userId, balance: { $gte: extra } },
              { $inc: { balance: -extra, totalLost: extra } }
            );
            fresh.balance -= extra;
          }
          await recordLoss(fresh, bet * game.riskMult);
          return ix.update({ embeds: [
            new EmbedBuilder()
              .setColor('#FF0000')
              .setTitle('💥  Bust!' + riskTag)
              .setDescription(SEP)
              .addFields(
                { name: '🃏 Your Hand',     value: fmtHand(game.playerHand) + '  =  **' + val + '**' },
                { name: "🎴 Dealer's Hand", value: fmtHand(game.dealerHand) + '  =  **' + handTotal(game.dealerHand) + '**' },
                { name: '💸 Lost',          value: '-' + fmt(bet * game.riskMult) + ' coins' },
                { name: '🏦 Wallet',        value: '**' + fmt(fresh.balance) + '** coins' },
              ),
          ], components: [] });
        }

        // Still in game — show updated hand
        return ix.update({ embeds: [
          new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('🃏  Blackjack' + riskTag)
            .setDescription(SEP)
            .addFields(
              { name: '🃏 Your Hand',        value: fmtHand(game.playerHand) + '  =  **' + val + '**' },
              { name: "🎴 Dealer's Visible", value: fmtCard(game.dealerHand[0]) + '  `??`' },
              { name: '💵 Bet',              value: fmt(bet) + ' coins' },
            )
            .setFooter({ text: 'Hit or Stand?' }),
        ], components: [bjRow] });
      }

      if (ix.customId === 'bj_stand_' + gameId) {
        while (handTotal(game.dealerHand) < 17) game.dealerHand.push(game.deck.pop());
        return resolveBJ(ix, handTotal(game.playerHand), handTotal(game.dealerHand), game);
      }
    });

    collector.on('end', function(_, reason) {
      if (reason === 'done') return;
      // Auto-stand on timeout
      const game = bjGames.get(gameId);
      if (!game) return;
      while (handTotal(game.dealerHand) < 17) game.dealerHand.push(game.deck.pop());
      resolveBJ(null, handTotal(game.playerHand), handTotal(game.dealerHand), game);
    });
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  ROULETTE  —  European 0–36, instant result
  //
  //  !roulette red    <bet>
  //  !roulette black  <bet>
  //  !roulette odd    <bet>
  //  !roulette even   <bet>
  //  !roulette green  <bet>
  //  !roulette number <0-36> <bet>
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'roulette' || command === 'rou') {
    const validTypes = ['red','black','odd','even','green','number'];
    const betType    = args[0] ? args[0].toLowerCase() : null;

    if (!betType || !validTypes.includes(betType)) {
      return message.reply(
        '❌ **Roulette Usage:**\n' +
        '`!roulette red <bet>`\n' +
        '`!roulette black <bet>`\n' +
        '`!roulette odd <bet>`\n' +
        '`!roulette even <bet>`\n' +
        '`!roulette green <bet>`\n' +
        '`!roulette number <0-36> <bet>`'
      );
    }

    let chosenNumber = null;
    let bet;

    if (betType === 'number') {
      chosenNumber = parseInt(args[1]);
      bet = parseInt(args[2]);
      if (isNaN(chosenNumber) || chosenNumber < 0 || chosenNumber > 36)
        return message.reply('❌ Number must be 0–36.');
      if (isNaN(bet) || bet <= 0)
        return message.reply('❌ Usage: `!roulette number <0-36> <bet>`');
    } else {
      bet = parseInt(args[1]);
      if (isNaN(bet) || bet <= 0)
        return message.reply('❌ Usage: `!roulette ' + betType + ' <bet>`');
    }

    // Atomic bet deduction
    const u = await User.findOneAndUpdate(
      { userId: userId, balance: { $gte: bet } },
      { $inc: { balance: -bet } },
      { new: true, upsert: false }
    );
    if (!u) {
      const cur = await getUser(userId);
      return message.reply('❌ Not enough coins! You have **' + fmt(cur.balance) + '**.');
    }

    // Consume risk token if armed — atomic
    const riskActive = !!armedRisk.get(userId);
    let riskConsumed = false;
    if (riskActive) {
      const riskUp = await User.findOneAndUpdate(
        { userId: userId, 'inventory.riskTokens': { $gte: 1 } },
        { $inc: { 'inventory.riskTokens': -1 } },
        { new: true }
      );
      if (riskUp) riskConsumed = true;
      armedRisk.delete(userId);
    }
    const riskMult = riskConsumed ? 5 : 1;
    const riskTag  = riskConsumed ? '  🔥 **5× RISK**' : '';

    await trackGame(userId, 'roulette');

    // Spin the wheel (0–36) — single source of truth, no conflicting matches
    const landed      = Math.floor(Math.random() * 37);
    const landedColor = rouletteColor(landed);
    const colorEmoji  = landedColor === 'red' ? '🔴' : landedColor === 'black' ? '⚫' : '🟢';

    // Determine win — exactly one bet type evaluated, exactly one payout used
    let won    = false;
    let payout = 2;

    if      (betType === 'red')    { won = landedColor === 'red';              payout = 2;  }
    else if (betType === 'black')  { won = landedColor === 'black';            payout = 2;  }
    else if (betType === 'odd')    { won = landed !== 0 && landed % 2 === 1;   payout = 2;  }
    else if (betType === 'even')   { won = landed !== 0 && landed % 2 === 0;   payout = 2;  }
    else if (betType === 'green')  { won = landedColor === 'green';            payout = 35; }
    else if (betType === 'number') { won = landed === chosenNumber;            payout = 35; }

    const fresh = await getUser(userId);
    let coinsText, embedColor, resultTitle;

    if (won) {
      const win = applyGambler(fresh, Math.floor(bet * payout * riskMult));
      const net = win - bet;
      await User.findOneAndUpdate({ userId: userId }, { $inc: { balance: win, totalWon: win } });
      fresh.balance += win;
      await recordWin(fresh, net);
      if (betType === 'number' || betType === 'green')
        await User.updateOne({ userId: userId }, { $addToSet: { achievements: 'ROULETTE_35' } });
      resultTitle = '🏆  Winner!' + riskTag;
      coinsText   = '**+' + fmt(win) + '** coins  *(net: +' + fmt(net) + ')*';
      embedColor  = '#00FF88';
    } else {
      const extra = bet * riskMult - bet;
      if (extra > 0) {
        await User.findOneAndUpdate(
          { userId: userId, balance: { $gte: extra } },
          { $inc: { balance: -extra, totalLost: extra } }
        );
        fresh.balance -= extra;
      }
      await recordLoss(fresh, bet * riskMult);
      resultTitle = '💀  No Luck!' + riskTag;
      coinsText   = '-' + fmt(bet * riskMult) + ' coins';
      embedColor  = '#FF4444';
    }

    const betLabel = betType === 'number'
      ? '#' + chosenNumber + ' (35×)'
      : betType === 'green'
        ? 'Green (35×)'
        : betType.charAt(0).toUpperCase() + betType.slice(1) + ' (2×)';

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🎡  Roulette — ' + resultTitle)
      .setDescription(SEP)
      .addFields(
        { name: '🎯 Your Bet',   value: '**' + betLabel + '**  •  **' + fmt(bet) + '** coins', inline: true },
        { name: '🎡 Landed',     value: colorEmoji + ' **' + landed + '** (' + landedColor + ')',  inline: true },
        { name: '💰 Result',     value: coinsText },
        { name: '🏦 Wallet',     value: '**' + fmt(fresh.balance) + '** coins',                    inline: true },
        { name: '🔥 Win Streak', value: String(fresh.winStreak),                                    inline: true },
      )
      .setFooter({ text: 'European Roulette 0–36  •  Red/Black/Odd/Even = 2×  •  Green/Number = 35×  •  0 = Green' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  SLOTS  —  Triples only, rebalanced payouts
  //  🍒3× 🍋4× 🍊5× 🍇7× 🔔10× ⭐20× 💎40× 7️⃣100×
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'slots') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!slots <bet>`');

    // Atomic bet deduction
    const u = await User.findOneAndUpdate(
      { userId: userId, balance: { $gte: bet } },
      { $inc: { balance: -bet } },
      { new: true, upsert: false }
    );
    if (!u) {
      const cur = await getUser(userId);
      return message.reply('❌ Need **' + fmt(bet) + '** coins, you have **' + fmt(cur.balance) + '**.');
    }

    await trackGame(userId, 'slots');

    // Weighted symbol pool — 7 is very rare (weight 1)
    const symbols = ['🍒','🍋','🍊','🍇','🔔','⭐','💎','7️⃣'];
    let   weights = [ 40,  32,  26,  20,  12,   8,   4,   1];

    // Lucky Charm boosts higher-tier symbols slightly
    if (u.inventory && u.inventory.luckyCharm) {
      weights = weights.map(function(w, i) { return i >= 4 ? w + 2 : w; });
    }

    const payouts = { '🍒': 3, '🍋': 4, '🍊': 5, '🍇': 7, '🔔': 10, '⭐': 20, '💎': 40, '7️⃣': 100 };

    function weightedPick() {
      const total = weights.reduce(function(a, b) { return a + b; }, 0);
      let r = Math.random() * total;
      for (let i = 0; i < symbols.length; i++) { r -= weights[i]; if (r <= 0) return symbols[i]; }
      return symbols[symbols.length - 1];
    }

    const reels      = [weightedPick(), weightedPick(), weightedPick()];
    const isTriple   = reels[0] === reels[1] && reels[1] === reels[2];
    const multiplier = isTriple ? (payouts[reels[0]] || 3) : 0;
    const isJackpot  = isTriple && reels[0] === '7️⃣';

    let resultText;
    if (isTriple) {
      if      (reels[0] === '7️⃣') resultText = '🎰 **JACKPOT! Triple 7s! 100×!**';
      else if (reels[0] === '💎')  resultText = '💎 **Triple Diamonds! 40×!**';
      else if (reels[0] === '⭐')  resultText = '⭐ **Triple Stars! 20×!**';
      else if (reels[0] === '🔔')  resultText = '🔔 **Triple Bells! 10×!**';
      else if (reels[0] === '🍇')  resultText = '🍇 **Triple Grapes! 7×!**';
      else if (reels[0] === '🍊')  resultText = '🍊 **Triple Oranges! 5×!**';
      else if (reels[0] === '🍋')  resultText = '🍋 **Triple Lemons! 4×!**';
      else                          resultText = '🍒 **Triple Cherries! 3×!**';
    } else {
      resultText = '💔 No triple. Try again!';
    }

    const fresh = await getUser(userId);
    let win = multiplier > 0 ? applyGambler(fresh, Math.floor(bet * multiplier)) : 0;
    const net = win - bet;

    if (win > 0) {
      await User.findOneAndUpdate({ userId: userId }, { $inc: { balance: win, totalWon: win }, $max: { biggestWin: net } });
      fresh.balance += win;
      await recordWin(fresh, net);
      if (isJackpot)
        await User.updateOne({ userId: userId }, { $addToSet: { achievements: 'LUCKY_SEVEN' } });
    } else {
      await recordLoss(fresh, bet);
    }

    const streakMsg = fresh.winStreak >= 5
      ? '\n🔥 **' + fresh.winStreak + '-game win streak!**'
      : fresh.winStreak >= 3
        ? '\n✨ ' + fresh.winStreak + ' in a row!'
        : '';

    const embed = new EmbedBuilder()
      .setColor(multiplier > 0 ? '#FFD700' : '#FF4444')
      .setTitle('🎰  Slots')
      .setDescription(SEP + '\n```\n│  ' + reels.join('  │  ') + '  │\n```\n' + SEP)
      .addFields(
        { name: '🎲 Result', value: resultText + streakMsg },
        { name: '💰 Net',    value: net >= 0 ? '**+' + fmt(net) + '** coins' : '-' + fmt(Math.abs(net)) + ' coins' },
        { name: '🏦 Wallet', value: '**' + fmt(fresh.balance) + '** coins', inline: true },
        { name: '🔥 Streak', value: fresh.winStreak + ' wins',               inline: true },
      )
      .setFooter({ text: (u.inventory && u.inventory.luckyCharm ? '🍀 Lucky Charm active!  •  ' : '') + 'Only triples win!  •  🍒3× 🍋4× 🍊5× 🍇7× 🔔10× ⭐20× 💎40× 7️⃣100×' });

    if (isJackpot && JACKPOT_CHANNEL) {
      const ch = client.channels.cache.get(JACKPOT_CHANNEL);
      if (ch) ch.send({ embeds: [
        new EmbedBuilder().setColor('#FFD700')
          .setTitle('🎰  JACKPOT ALERT!')
          .setDescription('🎉 <@' + userId + '> just hit **Triple 7s** in Slots and won **' + fmt(win) + '** coins!\n🏆 *Will you be next?*'),
      ]}).catch(function() {});
    }

    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  SUPER SLOTS  —  7×3 grid, rebalanced economy-safe payouts
  //  Row mults: 1=2× 2=5× 3=10× 4=25× 5=75× 6=250× 7=1000×
  //  Diamond row bonus: +250× each
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'superslots' || command === 'ss') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!superslots <bet>`');

    const u       = await getUser(userId);
    const cd      = u.inventory && u.inventory.fastCooldown ? SS_FAST_CD : SS_BASE_CD;
    const elapsed = Date.now() - (u.lastSuperSlots || 0);

    if (elapsed < cd) {
      const rem = cd - elapsed;
      return message.reply(
        '⏳ Super Slots cooldown: **' + fmtCooldown(rem) + '** remaining.' +
        (u.inventory && u.inventory.fastCooldown ? '' : '\n💡 Buy **⚡ Fast Cooldown** in `!shop` to reduce to 5s!')
      );
    }

    // Atomic bet deduction + cooldown timestamp
    const deducted = await User.findOneAndUpdate(
      { userId: userId, balance: { $gte: bet } },
      { $inc: { balance: -bet }, $set: { lastSuperSlots: Date.now() } },
      { new: true, upsert: false }
    );
    if (!deducted)
      return message.reply('❌ Need **' + fmt(bet) + '** coins, you have **' + fmt(u.balance) + '**.');

    await trackGame(userId, 'superslots');

    const ROWS = 7;
    const COLS = 3;
    const symbols       = ['🍒','🍋','🍊','🍇','⭐','🔔','💰','7️⃣','👑'];
    const DIAMOND_CHANCE = 0.004; // 0.4% per row (reduced for economy health)

    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      if (Math.random() < DIAMOND_CHANCE) {
        grid.push(['💎','💎','💎']);
      } else {
        const sym = symbols[Math.floor(Math.random() * symbols.length)];
        // 28% chance each cell matches the anchor — harder to match 3
        const row = [];
        for (let c = 0; c < COLS; c++) {
          row.push(Math.random() < 0.28 ? sym : symbols[Math.floor(Math.random() * symbols.length)]);
        }
        grid.push(row);
      }
    }

    // Rebalanced multipliers indexed by winning-row count (0–7)
    const rowMults  = [0, 2, 5, 10, 25, 75, 250, 1000];
    let winRows     = 0;
    let diamondRows = 0;

    for (const row of grid) {
      if (row[0] === row[1] && row[1] === row[2]) {
        if (row[0] === '💎') diamondRows++;
        else                  winRows++;
      }
    }

    const baseMult     = rowMults[Math.min(winRows, 7)];
    const diamondBonus = diamondRows * 250;
    const totalMult    = baseMult + diamondBonus;

    const fresh = await getUser(userId);
    let win = totalMult > 0 ? applyGambler(fresh, Math.floor(bet * totalMult)) : 0;
    const net = win - bet;

    if (win > 0) {
      await User.findOneAndUpdate({ userId: userId }, { $inc: { balance: win, totalWon: win }, $max: { biggestWin: net } });
      fresh.balance += win;
      await recordWin(fresh, net);
    } else {
      await recordLoss(fresh, bet);
    }

    if (diamondRows > 0)
      await User.updateOne({ userId: userId }, { $addToSet: { achievements: 'DIAMOND_ROW' } });

    // Build grid display
    const gridLines = grid.map(function(row) {
      const allSame = row[0] === row[1] && row[1] === row[2];
      return (allSame ? '✅' : '▪️') + '  ' + row.join('  ');
    }).join('\n');

    let resultText;
    if (!winRows && !diamondRows) {
      resultText = '💔 No winning rows.';
    } else {
      resultText = '';
      if (winRows     > 0) resultText += '🎰 **' + winRows + '** row' + (winRows > 1 ? 's' : '') + ' → **' + baseMult + '×**\n';
      if (diamondRows > 0) resultText += '💎 **' + diamondRows + '** Diamond row' + (diamondRows > 1 ? 's' : '') + ' → **+' + diamondBonus + '×**\n';
      resultText += '🏁 Total: **' + totalMult + '×**';
    }

    if (totalMult >= 250 && JACKPOT_CHANNEL) {
      const ch = client.channels.cache.get(JACKPOT_CHANNEL);
      if (ch) ch.send({ embeds: [
        new EmbedBuilder().setColor('#FF00FF')
          .setTitle('💎  SUPER SLOTS MEGA WIN!')
          .setDescription('<@' + userId + '> hit **' + totalMult + '×** in Super Slots and won **' + fmt(win) + '** coins! 🤯'),
      ]}).catch(function() {});
    }

    const embed = new EmbedBuilder()
      .setColor(totalMult > 0 ? '#FFD700' : '#FF4444')
      .setTitle('💎  SUPER SLOTS  —  7×3')
      .setDescription(SEP + '\n```\n' + gridLines + '\n```\n' + SEP)
      .addFields(
        { name: '🎲 Result',   value: resultText },
        { name: '💰 Net',      value: net >= 0 ? '**+' + fmt(net) + '** coins' : '-' + fmt(Math.abs(net)) + ' coins' },
        { name: '🏦 Wallet',   value: '**' + fmt(fresh.balance) + '** coins', inline: true },
        { name: '⏱ Cooldown', value: cd / 1000 + 's',                          inline: true },
      )
      .setFooter({ text: '✅ = winning row  |  💎 Diamond row = +250×  |  1=2× 2=5× 3=10× 4=25× 5=75× 6=250× 7=1000×' });

    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  HELP
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎰  Casino Bot — Command Guide')
      .setDescription(SEP)
      .addFields(
        {
          name: '💰 Economy',
          value:
            '`!balance` / `!bal` — Wallet balance & stats\n' +
            '`!daily` — Daily reward (10,000–15,000 + streak bonus)\n' +
            '`!hourly` — Hourly reward (1,000–2,000 coins • 1h cooldown)\n' +
            '`!work` — Work a job (500–3,000 coins • 30m cooldown)\n' +
            '`!profile [@user]` — Full casino profile\n' +
            '`!inventory` — View owned items\n' +
            '`!leaderboard` / `!top` — Top 10 richest (wallet)\n' +
            '`!topwins` — Top 10 by total winnings\n' +
            '`!topprofit` — Top 10 by overall profit',
        },
        {
          name: '🏦 Bank',
          value:
            '`!bank` / `!bankbalance` — View your bank (private)\n' +
            '`!deposit <amount|all>` — Move coins to bank\n' +
            '`!withdraw <amount|all>` — Move coins to wallet\n' +
            '*Max: **' + fmt(BANK_MAX) + '** coins  •  Bank funds cannot be gambled*',
        },
        {
          name: '🛒 Shop',
          value:
            '`!shop` — Browse & buy items (button UI)\n' +
            '`!userisk` / `!arm` — Arm a 🔥 Risk Token for next BJ/Roulette\n' +
            '`!opencrate` / `!crate` — Open a 📦 Mystery Crate',
        },
        {
          name: '🃏 Blackjack',
          value:
            '`!blackjack <bet>` / `!bj <bet>`\n' +
            '• Natural BJ pays **2.5×** • Win pays **2×**\n' +
            '• 60s timeout → auto-stand • Risk Token = 5× win/loss',
        },
        {
          name: '🎡 Roulette  (European 0–36, instant)',
          value:
            '`!roulette red <bet>` — 2× payout\n' +
            '`!roulette black <bet>` — 2× payout\n' +
            '`!roulette odd <bet>` — 2× payout\n' +
            '`!roulette even <bet>` — 2× payout\n' +
            '`!roulette number <0-36> <bet>` — **35×** payout\n' +
            '• 🟢 0 = Green (all bets lose) • Risk Token = 5× win/loss',
        },
        {
          name: '🎰 Slots  (Triples only)',
          value:
            '`!slots <bet>`\n' +
            '🍒 3×  🍋 4×  🍊 5×  🍇 7×  🔔 10×  ⭐ 20×  💎 40×  7️⃣ 100×\n' +
            '*Only triple matches pay out — no two-of-a-kind*',
        },
        {
          name: '💎 Super Slots  (7 rows × 3 cols)',
          value:
            '`!superslots <bet>` / `!ss <bet>`\n' +
            '• 20s cooldown (5s with ⚡ Fast Cooldown)\n' +
            '• 1row=**2×** 2=**5×** 3=**10×** 4=**25×** 5=**75×** 6=**250×** 7=**1000×**\n' +
            '• 💎 Diamond row = **+250×** per row (ultra rare)',
        },
      )
      .setFooter({ text: 'Good luck! 🍀  |  Use !profile to track all your stats' });
    return message.reply({ embeds: [embed] });
  }

   if (command === 'cat') {
    const cats = [
      'https://giphy.com/gifs/chubbiverse-chubbicorns-chubbicorn-chubbifrens-yF4Y0v5jgJW7k7bAxE',
      'https://tenor.com/view/gif-gif-11244246814270150217',
      'https://cdn.discordapp.com/attachments/1297220928262115371/1508379676748288080/Car_P.gif',
      'https://cdn.discordapp.com/attachments/1319378520316710983/1509199781162123438/200w.gif',
      'https://cdn.discordapp.com/attachments/1297220928262115371/1475460327943573556/1000044567.gif',
    ];

    return message.reply(
      cats[Math.floor(Math.random() * cats.length)]
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    if (!MONGO) {
        throw new Error('MONGO_URI environment variable is missing.');
    }

    if (!TOKEN) {
        throw new Error('DISCORD_TOKEN environment variable is missing.');
    }

    await mongoose.connect(MONGO);

    console.log('✅ MongoDB connected');

    await client.login(TOKEN);

    console.log('🤖 Bot logged in');
}

main().catch((err) => { console.error('❌ Boot error:', err); process.exit(1);});
