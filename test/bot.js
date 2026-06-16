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
const TOKEN   = process.env.DISCORD_TOKEN;
const MONGO   = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/casinobot';
const PREFIX  = '!';
const JACKPOT_CHANNEL = process.env.JACKPOT_CHANNEL_ID || null; // optional

if (!TOKEN) { console.error('❌  DISCORD_TOKEN missing'); process.exit(1); }

// ═══════════════════════════════════════════════════════════════════════════════
//  MONGOOSE SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

const userSchema = new mongoose.Schema({
  userId:        { type: String, required: true, unique: true, index: true },
  balance:       { type: Number, default: 1000 },
  totalWon:      { type: Number, default: 0 },
  totalLost:     { type: Number, default: 0 },
  gamesPlayed:   { type: Number, default: 0 },
  gamesWon:      { type: Number, default: 0 },
  gamesLost:     { type: Number, default: 0 },
  biggestWin:    { type: Number, default: 0 },
  winStreak:     { type: Number, default: 0 },
  bestWinStreak: { type: Number, default: 0 },
  dailyStreak:   { type: Number, default: 0 },
  lastDaily:     { type: Number, default: 0 },
  lastSuperSlots:{ type: Number, default: 0 },
  inventory: {
    fastCooldown: { type: Boolean, default: false },
    gamblerRole:  { type: Boolean, default: false },
    luckyCharm:   { type: Boolean, default: false },
    vip:          { type: Boolean, default: false },
    jackpotTickets: { type: Number, default: 0 },
    mysteryCrates:  { type: Number, default: 0 },
    riskTokens:     { type: Number, default: 0 },
  },
  achievements:  { type: [String], default: [] },
  flags: {
    vip:          { type: Boolean, default: false },
    gambler:      { type: Boolean, default: false },
    fastCooldown: { type: Boolean, default: false },
  },
  riskTokens:    { type: Number, default: 0 }, // legacy alias kept
}, { timestamps: true });

const User = mongoose.models.User || mongoose.model('User', userSchema);

// ═══════════════════════════════════════════════════════════════════════════════
//  DB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function getUser(userId) {
  let user = await User.findOne({ userId });
  if (!user) user = await User.create({ userId });
  return user;
}

async function saveUser(user) {
  return user.save();
}

async function updateBalance(userId, amount) {
  const inc = { balance: amount };
  if (amount > 0) inc.totalWon = amount;
  else           inc.totalLost = Math.abs(amount);
  return User.findOneAndUpdate(
    { userId },
    { $inc: inc },
    { new: true, upsert: true }
  );
}

function applyGambler(user, amount) {
  if (amount > 0 && (user.inventory?.gamblerRole || user.flags?.gambler)) {
    return Math.floor(amount * 1.1);
  }
  return amount;
}

function applyLucky(user, slots) {
  // +5% chance improvement for Lucky Charm (handled via weight boost)
  return !!(user.inventory?.luckyCharm);
}

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

async function recordLoss(user, net) {
  user.gamesPlayed = (user.gamesPlayed || 0) + 1;
  user.gamesLost   = (user.gamesLost   || 0) + 1;
  user.totalLost   = (user.totalLost   || 0) + Math.abs(net);
  user.winStreak   = 0;
  checkAchievements(user);
  await saveUser(user);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ACHIEVEMENTS
// ═══════════════════════════════════════════════════════════════════════════════

const ACHIEVEMENTS = {
  FIRST_WIN:        { id: 'FIRST_WIN',        label: '🏅 First Win',          desc: 'Win your first game'                   },
  HIGH_ROLLER:      { id: 'HIGH_ROLLER',       label: '💸 High Roller',         desc: 'Win over 1,000,000 coins in one round' },
  LUCKY_SEVEN:      { id: 'LUCKY_SEVEN',       label: '7️⃣  Lucky Seven',        desc: 'Hit triple 7s in Slots'                },
  STREAK_5:         { id: 'STREAK_5',          label: '🔥 On Fire',             desc: '5-game win streak'                     },
  STREAK_10:        { id: 'STREAK_10',         label: '🌋 Unstoppable',          desc: '10-game win streak'                    },
  MILLIONAIRE:      { id: 'MILLIONAIRE',       label: '💰 Millionaire',          desc: 'Reach 1,000,000 balance'              },
  BLACKJACK_NATURAL:{ id: 'BLACKJACK_NATURAL', label: '🃏 Natural',             desc: 'Hit a natural blackjack'              },
  DIAMOND_ROW:      { id: 'DIAMOND_ROW',       label: '💎 Diamond Luck',        desc: 'Land a Diamond row in Super Slots'    },
  DAILY_30:         { id: 'DAILY_30',          label: '📅 Dedicated',           desc: '30-day daily streak'                  },
};

function checkAchievements(user) {
  const earned = new Set(user.achievements || []);
  const add = (id) => { if (!earned.has(id)) { earned.add(id); user.achievements = [...earned]; } };

  if ((user.gamesWon || 0) >= 1)           add('FIRST_WIN');
  if ((user.biggestWin || 0) >= 1_000_000)  add('HIGH_ROLLER');
  if ((user.winStreak || 0) >= 5)           add('STREAK_5');
  if ((user.winStreak || 0) >= 10)          add('STREAK_10');
  if ((user.balance || 0) >= 1_000_000)     add('MILLIONAIRE');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const SS_BASE_CD = 20_000;
const SS_FAST_CD =  5_000;
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━';

const SHOP_ITEMS = {
  fastcooldown: {
    key: 'fastcooldown', name: '⚡ Fast Cooldown', emoji: '⚡',
    desc: 'Lowers Super Slots cooldown: 20s → 5s  **(Permanent)**',
    price: 10_000_000, type: 'permanent', field: 'fastCooldown',
  },
  gambler: {
    key: 'gambler', name: '🎩 Gambler Role', emoji: '🎩',
    desc: 'All winnings multiplied by **1.1×**  **(Permanent)**',
    price: 50_000_000, type: 'permanent', field: 'gamblerRole',
  },
  risktoken: {
    key: 'risktoken', name: '🔥 Risk Token', emoji: '🔥',
    desc: 'Consumable — 5× win **or** 5× loss on next BJ/Roulette',
    price: 2_500_000, type: 'consumable', field: 'riskTokens',
  },
  luckycharm: {
    key: 'luckycharm', name: '🍀 Lucky Charm', emoji: '🍀',
    desc: '+5% bonus weight on every slots spin  **(Permanent)**',
    price: 5_000_000, type: 'permanent', field: 'luckyCharm',
  },
  vip: {
    key: 'vip', name: '💎 VIP', emoji: '💎',
    desc: 'VIP badge on profile + hidden bonus multipliers  **(Permanent)**',
    price: 100_000_000, type: 'permanent', field: 'vip',
  },
  jackpotticket: {
    key: 'jackpotticket', name: '🎟 Jackpot Ticket', emoji: '🎟',
    desc: 'Consumable — grants 1 free Super Slots spin (min bet)',
    price: 500_000, type: 'consumable', field: 'jackpotTickets',
  },
  mysterycrate: {
    key: 'mysterycrate', name: '📦 Mystery Crate', emoji: '📦',
    desc: 'Consumable — open for a random coin reward or item!',
    price: 750_000, type: 'consumable', field: 'mysteryCrates',
  },
};

// In-memory session maps (no DB calls needed)
const activeGames  = new Map(); // userId -> gameId (one BJ at a time)
const bjGames      = new Map(); // gameId -> game state
const armedRisk    = new Map(); // userId -> true
const riskBuyQty   = new Map(); // userId -> qty

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

function fmt(n) { return Number(n).toLocaleString(); }
function winRate(user) {
  const g = user.gamesPlayed || 0;
  if (!g) return '0%';
  return ((user.gamesWon / g) * 100).toFixed(1) + '%';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════════════════════
//  SHOP UI
// ═══════════════════════════════════════════════════════════════════════════════

function buildShopEmbed(user, qty = 1) {
  const inv = user.inventory || {};
  const lines = Object.values(SHOP_ITEMS).map(item => {
    let owned = '';
    if (item.type === 'permanent') owned = inv[item.field] ? '  ✅ **OWNED**' : '';
    else owned = `  📦 **Owned: ${inv[item.field] || 0}**`;
    const price = item.type === 'consumable'
      ? `${fmt(item.price)} × ${qty} = **${fmt(item.price * qty)}** coins`
      : `**${fmt(item.price)}** coins`;
    return `${item.emoji} **${item.name}** — ${price}\n┗ ${item.desc}${owned}`;
  }).join('\n\n');

  return new EmbedBuilder()
    .setColor('#9B59B6')
    .setTitle('🛒  Casino Shop')
    .setDescription(`${SEP}\n${lines}\n${SEP}`)
    .addFields({ name: '💰 Your Balance', value: `**${fmt(user.balance)}** coins`, inline: true })
    .setFooter({ text: 'Use the buttons below to purchase • Permanent items bought once' });
}

function buildShopRows(user, qty = 1) {
  const inv = user.inventory || {};
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_fastcooldown').setEmoji('⚡')
      .setLabel(inv.fastCooldown ? 'Owned ✅' : `Fast Cooldown`)
      .setStyle(ButtonStyle.Primary).setDisabled(!!inv.fastCooldown),
    new ButtonBuilder().setCustomId('shop_gambler').setEmoji('🎩')
      .setLabel(inv.gamblerRole ? 'Owned ✅' : `Gambler Role`)
      .setStyle(ButtonStyle.Success).setDisabled(!!inv.gamblerRole),
    new ButtonBuilder().setCustomId('shop_luckycharm').setEmoji('🍀')
      .setLabel(inv.luckyCharm ? 'Owned ✅' : `Lucky Charm`)
      .setStyle(ButtonStyle.Primary).setDisabled(!!inv.luckyCharm),
    new ButtonBuilder().setCustomId('shop_vip').setEmoji('💎')
      .setLabel(inv.vip ? 'Owned ✅' : `VIP`)
      .setStyle(ButtonStyle.Success).setDisabled(!!inv.vip),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_qty_minus').setLabel('−').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shop_qty_display').setLabel(`Qty: ${qty}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('shop_qty_plus').setLabel('+').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shop_risktoken').setEmoji('🔥')
      .setLabel(`Risk Token  (${fmt(SHOP_ITEMS.risktoken.price * qty)})`)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('shop_mysterycrate').setEmoji('📦')
      .setLabel(`Mystery Crate  (${fmt(SHOP_ITEMS.mysterycrate.price * qty)})`)
      .setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_jackpotticket').setEmoji('🎟')
      .setLabel(`Jackpot Ticket  (${fmt(SHOP_ITEMS.jackpotticket.price * qty)})`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shop_arm_risk').setEmoji('🎯')
      .setLabel('Arm Risk Token')
      .setStyle(ButtonStyle.Danger)
      .setDisabled((inv.riskTokens || 0) <= 0),
  );
  return [row1, row2, row3];
}

async function attachShopCollector(msg, ownerId) {
  riskBuyQty.set(ownerId, 1);
  const collector = msg.createMessageComponentCollector({ time: 120_000 });

  collector.on('collect', async (ix) => {
    if (ix.user.id !== ownerId)
      return ix.reply({ content: "❌ Open your own shop with `!shop`", ephemeral: true });

    const user = await getUser(ownerId);
    const inv  = user.inventory;
    let qty    = riskBuyQty.get(ownerId) || 1;

    // Qty buttons
    if (ix.customId === 'shop_qty_minus') {
      qty = Math.max(1, qty - 1); riskBuyQty.set(ownerId, qty);
      return ix.update({ embeds: [buildShopEmbed(user, qty)], components: buildShopRows(user, qty) });
    }
    if (ix.customId === 'shop_qty_plus') {
      qty = Math.min(99, qty + 1); riskBuyQty.set(ownerId, qty);
      return ix.update({ embeds: [buildShopEmbed(user, qty)], components: buildShopRows(user, qty) });
    }

    // Permanent items
    const permanents = {
      shop_fastcooldown: { item: SHOP_ITEMS.fastcooldown, field: 'fastCooldown' },
      shop_gambler:      { item: SHOP_ITEMS.gambler,      field: 'gamblerRole'  },
      shop_luckycharm:   { item: SHOP_ITEMS.luckycharm,   field: 'luckyCharm'   },
      shop_vip:          { item: SHOP_ITEMS.vip,          field: 'vip'          },
    };
    if (permanents[ix.customId]) {
      const { item, field } = permanents[ix.customId];
      if (inv[field]) return ix.reply({ content: `❌ You already own **${item.name}**.`, ephemeral: true });
      if (user.balance < item.price) return ix.reply({ content: `❌ Need **${fmt(item.price)}** coins, you have **${fmt(user.balance)}**.`, ephemeral: true });
      user.balance  -= item.price;
      inv[field]     = true;
      await saveUser(user);
      await ix.reply({ content: `✅ Purchased **${item.name}**!`, ephemeral: true });
      return ix.message.edit({ embeds: [buildShopEmbed(user, qty)], components: buildShopRows(user, qty) });
    }

    // Consumables
    const consumables = {
      shop_risktoken:     { item: SHOP_ITEMS.risktoken,     field: 'riskTokens'    },
      shop_jackpotticket: { item: SHOP_ITEMS.jackpotticket, field: 'jackpotTickets' },
      shop_mysterycrate:  { item: SHOP_ITEMS.mysterycrate,  field: 'mysteryCrates'  },
    };
    if (consumables[ix.customId]) {
      const { item, field } = consumables[ix.customId];
      const cost = item.price * qty;
      if (user.balance < cost) return ix.reply({ content: `❌ Need **${fmt(cost)}** coins, you have **${fmt(user.balance)}**.`, ephemeral: true });
      user.balance -= cost;
      inv[field]    = (inv[field] || 0) + qty;
      await saveUser(user);
      await ix.reply({ content: `✅ Purchased **${qty}× ${item.name}**! You now own **${inv[field]}**.`, ephemeral: true });
      return ix.message.edit({ embeds: [buildShopEmbed(user, qty)], components: buildShopRows(user, qty) });
    }

    // Arm risk token
    if (ix.customId === 'shop_arm_risk') {
      if ((inv.riskTokens || 0) <= 0) return ix.reply({ content: '❌ No Risk Tokens.', ephemeral: true });
      if (armedRisk.get(ownerId)) return ix.reply({ content: '⚠️ Already armed for next round.', ephemeral: true });
      armedRisk.set(ownerId, true);
      return ix.reply({ content: '🔥 **Risk Token armed!** Your next BJ or Roulette round is 5× win/loss.', ephemeral: true });
    }
  });

  collector.on('end', () => {
    riskBuyQty.delete(ownerId);
    msg.edit({ components: [] }).catch(() => {});
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CARDS (BLACKJACK)
// ═══════════════════════════════════════════════════════════════════════════════

function buildDeck() {
  const suits  = ['♠', '♥', '♦', '♣'];
  const values = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const deck   = [];
  for (const s of suits) for (const v of values) deck.push({ s, v });
  // Fisher-Yates
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardVal(card) {
  if (['J','Q','K'].includes(card.v)) return 10;
  if (card.v === 'A') return 11;
  return parseInt(card.v);
}

function handTotal(hand) {
  let t = hand.reduce((s, c) => s + cardVal(c), 0);
  let a = hand.filter(c => c.v === 'A').length;
  while (t > 21 && a-- > 0) t -= 10;
  return t;
}

function fmtCard(c) { return `\`${c.v}${c.s}\``; }
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

client.once('ready', () => console.log(`✅  ${client.user.tag} online`));

// ═══════════════════════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const raw     = message.content.slice(PREFIX.length).trim();
  const args    = raw.split(/\s+/);
  const command = args.shift().toLowerCase();
  const userId  = message.author.id;
  const user    = message.author;

  // ─────────────────────────────────────────────────────────────────────────
  //  BALANCE
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'balance' || command === 'bal') {
    const u = await getUser(userId);
    const inv = u.inventory || {};
    const badges = [
      inv.vip         ? '💎 VIP'        : '',
      inv.gamblerRole ? '🎩 Gambler'    : '',
      inv.luckyCharm  ? '🍀 Lucky'      : '',
      inv.fastCooldown? '⚡ FastCD'     : '',
    ].filter(Boolean).join('  ');

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`💰  ${user.username}'s Balance`)
      .setThumbnail(user.displayAvatarURL())
      .setDescription(badges ? `${badges}\n${SEP}` : SEP)
      .addFields(
        { name: '💵 Balance',    value: `**${fmt(u.balance)}** coins`,           inline: true },
        { name: '📈 Total Won',  value: `${fmt(u.totalWon)} coins`,              inline: true },
        { name: '📉 Total Lost', value: `${fmt(u.totalLost)} coins`,             inline: true },
        { name: '🔥 Risk Tokens',value: `${inv.riskTokens || 0}`,               inline: true },
        { name: '🎟 Tickets',    value: `${inv.jackpotTickets || 0}`,            inline: true },
        { name: '📦 Crates',     value: `${inv.mysteryCrates || 0}`,             inline: true },
      )
      .setFooter({ text: `Win Rate: ${winRate(u)}  •  Games: ${fmt(u.gamesPlayed)}` });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  PROFILE
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'profile') {
    const target = message.mentions.users.first() || user;
    const u = await getUser(target.id);
    const inv = u.inventory || {};
    const ach = (u.achievements || []).map(id => ACHIEVEMENTS[id]?.label || id).join('\n') || '*None yet*';

    const badges = [
      inv.vip         ? '💎 VIP'     : null,
      inv.gamblerRole ? '🎩 Gambler' : null,
      inv.luckyCharm  ? '🍀 Lucky'   : null,
      inv.fastCooldown? '⚡ FastCD'  : null,
    ].filter(Boolean).join('  ') || '*No badges*';

    const embed = new EmbedBuilder()
      .setColor(inv.vip ? '#FFD700' : '#5865F2')
      .setTitle(`🎰  ${target.username}'s Casino Profile`)
      .setThumbnail(target.displayAvatarURL())
      .setDescription(`${badges}\n${SEP}`)
      .addFields(
        { name: '💰 Balance',       value: `**${fmt(u.balance)}** coins`,             inline: true },
        { name: '🏆 Biggest Win',   value: `${fmt(u.biggestWin)} coins`,              inline: true },
        { name: '📊 Win Rate',      value: winRate(u),                               inline: true },
        { name: '🎮 Games Played',  value: fmt(u.gamesPlayed),                       inline: true },
        { name: '✅ Games Won',      value: fmt(u.gamesWon),                          inline: true },
        { name: '❌ Games Lost',     value: fmt(u.gamesLost),                         inline: true },
        { name: '🔥 Best Streak',   value: `${u.bestWinStreak} wins`,               inline: true },
        { name: '📅 Daily Streak',  value: `${u.dailyStreak} days`,                  inline: true },
        { name: '📈 Total Won',      value: `${fmt(u.totalWon)} coins`,               inline: true },
        { name: `🏅 Achievements (${(u.achievements||[]).length})`, value: ach },
      )
      .setFooter({ text: `Member since ${new Date(u.createdAt).toDateString()}` });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  INVENTORY
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'inventory' || command === 'inv') {
    const u   = await getUser(userId);
    const inv = u.inventory || {};
    const lines = Object.values(SHOP_ITEMS).map(item => {
      if (item.type === 'permanent') {
        return `${item.emoji} **${item.name}** — ${inv[item.field] ? '✅ Active' : '❌ Not owned'}`;
      }
      return `${item.emoji} **${item.name}** — **${inv[item.field] || 0}** owned`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('🎒  Your Inventory')
      .setDescription(`${SEP}\n${lines}\n${SEP}`)
      .setThumbnail(user.displayAvatarURL())
      .setFooter({ text: 'Buy items with !shop' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  LEADERBOARD
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'leaderboard' || command === 'top' || command === 'lb') {
    const top = await User.find().sort({ balance: -1 }).limit(10).lean();
    if (!top.length) return message.reply('No players yet!');

    const medals = ['🥇','🥈','🥉'];
    let desc = `${SEP}\n`;
    for (let i = 0; i < top.length; i++) {
      const tag = medals[i] || `**${i + 1}.**`;
      let uTag = `<@${top[i].userId}>`;
      desc += `${tag}  ${uTag}  —  **${fmt(top[i].balance)}** coins\n`;
    }
    desc += SEP;

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🏆  Casino Leaderboard — Top 10 Richest')
      .setDescription(desc)
      .setFooter({ text: 'Updated live • Use !profile to view stats' });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  DAILY
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'daily') {
    const u   = await getUser(userId);
    const now = Date.now();
    const diff = now - (u.lastDaily || 0);

    if (diff < 86_400_000) {
      const rem  = 86_400_000 - diff;
      const hrs  = Math.floor(rem / 3_600_000);
      const mins = Math.floor((rem % 3_600_000) / 60_000);
      return message.reply(`⏳ Daily already claimed! Come back in **${hrs}h ${mins}m**.`);
    }

    // Streak: if claimed within 48h but not 24h reset
    const newStreak = diff < 172_800_000 ? (u.dailyStreak || 0) + 1 : 1;
    const bonus  = Math.min(newStreak * 50, 1000);
    const reward = 500 + bonus;

    u.lastDaily   = now;
    u.dailyStreak = newStreak;
    u.balance     = (u.balance || 0) + reward;
    u.totalWon    = (u.totalWon || 0) + reward;
    if (newStreak >= 30) { const a = u.achievements || []; if (!a.includes('DAILY_30')) { a.push('DAILY_30'); u.achievements = a; } }
    await saveUser(u);

    const embed = new EmbedBuilder()
      .setColor('#00FF88')
      .setTitle('🎁  Daily Reward!')
      .setDescription(`${SEP}\n💵 Base reward: **500** coins\n🔥 Streak bonus: **+${bonus}** coins\n🎯 Day streak: **${newStreak}**\n${SEP}\n✨ You received **${fmt(reward)}** coins!\n💰 New balance: **${fmt(u.balance)}**`)
      .setFooter({ text: 'Come back tomorrow for a bigger streak bonus!' });
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
    if ((u.inventory?.riskTokens || 0) <= 0)
      return message.reply('❌ No 🔥 Risk Tokens. Buy one with `!shop`.');
    if (armedRisk.get(userId))
      return message.reply('⚠️ Already armed for next BJ or Roulette round.');
    armedRisk.set(userId, true);
    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle('🔥  Risk Token Armed!')
      .setDescription(`${SEP}\nYour next **Blackjack** or **Roulette** round will multiply win/loss by **5×**.\n\nWin big — or lose big.\n${SEP}`)
      .addFields({ name: '🔥 Remaining Tokens', value: `${(u.inventory.riskTokens || 0) - 1}` });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  OPEN MYSTERY CRATE
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'opencrate' || command === 'crate') {
    const u = await getUser(userId);
    const inv = u.inventory;
    if ((inv.mysteryCrates || 0) <= 0)
      return message.reply('❌ No 📦 Mystery Crates. Buy one with `!shop`.');
    inv.mysteryCrates -= 1;

    const roll = Math.random();
    let reward = '', color = '#FFD700';
    if (roll < 0.03) {
      const prize = 5_000_000; u.balance += prize; u.totalWon += prize;
      reward = `💰 **JACKPOT!** You found **${fmt(prize)}** coins!`; color = '#00FF00';
    } else if (roll < 0.15) {
      inv.riskTokens = (inv.riskTokens || 0) + 1;
      reward = '🔥 You found a **Risk Token**!'; color = '#FF4500';
    } else if (roll < 0.30) {
      inv.jackpotTickets = (inv.jackpotTickets || 0) + 1;
      reward = '🎟 You found a **Jackpot Ticket**!';
    } else if (roll < 0.50) {
      const prize = Math.floor(Math.random() * 250_000) + 50_000;
      u.balance += prize; u.totalWon += prize;
      reward = `💵 You found **${fmt(prize)}** coins!`;
    } else {
      const prize = Math.floor(Math.random() * 50_000) + 5_000;
      u.balance += prize; u.totalWon += prize;
      reward = `🪙 You found **${fmt(prize)}** coins.`; color = '#888888';
    }
    await saveUser(u);

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle('📦  Mystery Crate Opened!')
      .setDescription(`${SEP}\n${reward}\n${SEP}`)
      .addFields({ name: '💰 Balance', value: `**${fmt(u.balance)}** coins`, inline: true },
                 { name: '📦 Crates Left', value: `${inv.mysteryCrates}`, inline: true });
    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  BLACKJACK
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'blackjack' || command === 'bj') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!blackjack <bet>`');

    if (activeGames.has(userId))
      return message.reply('❌ You already have a Blackjack game in progress!');

    const u = await getUser(userId);
    if (u.balance < bet) return message.reply(`❌ Not enough coins! You have **${fmt(u.balance)}**.`);

    // Consume risk token if armed
    const riskActive = !!armedRisk.get(userId);
    let riskConsumed = false;
    if (riskActive) {
      if ((u.inventory.riskTokens || 0) > 0) {
        u.inventory.riskTokens -= 1;
        riskConsumed = true;
      }
      armedRisk.delete(userId);
      await saveUser(u);
    }
    const riskMult = riskConsumed ? 5 : 1;
    const riskTag  = riskConsumed ? '  🔥 **5× RISK**' : '';

    // Deduct bet
    u.balance -= bet;
    await saveUser(u);

    const deck       = buildDeck();
    const playerHand = [deck.pop(), deck.pop()];
    const dealerHand = [deck.pop(), deck.pop()];

    const gameId = `bj_${userId}_${Date.now()}`;
    activeGames.set(userId, gameId);
    bjGames.set(gameId, { deck, playerHand, dealerHand, bet, userId, riskMult, riskConsumed, msg: null });

    const pVal = handTotal(playerHand);
    const dVal = handTotal(dealerHand);

    // Natural blackjack
    if (pVal === 21) {
      let win = Math.floor(bet * 2.5 * riskMult);
      win = applyGambler(u, win);
      u.balance += win;
      await recordWin(u, win - bet);
      if (!u.achievements?.includes('BLACKJACK_NATURAL')) {
        u.achievements = [...(u.achievements || []), 'BLACKJACK_NATURAL'];
      }
      await saveUser(u);
      activeGames.delete(userId);
      bjGames.delete(gameId);

      const embed = new EmbedBuilder()
        .setColor('#00FF88')
        .setTitle(`🃏  BLACKJACK!  Natural 21!${riskTag}`)
        .setDescription(`${SEP}\n🎉 You hit a natural blackjack — pays **2.5×**!\n${SEP}`)
        .addFields(
          { name: '🃏 Your Hand',    value: `${fmtHand(playerHand)}  =  **${pVal}**` },
          { name: "🎴 Dealer's Hand", value: `${fmtHand(dealerHand)}  =  **${dVal}**` },
          { name: '💰 Winnings',      value: `**+${fmt(win)}** coins` },
          { name: '🏦 New Balance',   value: `**${fmt(u.balance)}** coins` },
        )
        .setFooter({ text: u.gamblerRole ? '🎩 Gambler 1.1× applied' : 'Play again with !blackjack' });
      return message.reply({ embeds: [embed] });
    }

    function buildBJEmbed(extra = '', color = '#FFD700') {
      return new EmbedBuilder()
        .setColor(color)
        .setTitle(`🃏  Blackjack${riskTag}`)
        .setDescription(`${SEP}`)
        .addFields(
          { name: '🃏 Your Hand',        value: `${fmtHand(playerHand)}  =  **${handTotal(playerHand)}**` },
          { name: "🎴 Dealer's Visible",  value: `${fmtCard(dealerHand[0])}  \`??\`` },
          { name: '💵 Bet',              value: `${fmt(bet)} coins` + (riskConsumed ? '  🔥 *5× risk*' : '') },
        )
        .setFooter({ text: extra || 'Hit or Stand? (60s timeout → auto-stand)' });
    }

    const hitBtn   = new ButtonBuilder().setCustomId(`bj_hit_${gameId}`).setLabel('HIT').setStyle(ButtonStyle.Primary).setEmoji('👊');
    const standBtn = new ButtonBuilder().setCustomId(`bj_stand_${gameId}`).setLabel('STAND').setStyle(ButtonStyle.Secondary).setEmoji('✋');
    const row      = new ActionRowBuilder().addComponents(hitBtn, standBtn);

    const sentMsg = await message.reply({ embeds: [buildBJEmbed()], components: [row] });
    bjGames.get(gameId).msg = sentMsg;

    const collector = sentMsg.createMessageComponentCollector({ time: 60_000 });

    async function resolveBJ(interaction, playerFinal, dealerFinal, game) {
      activeGames.delete(userId);
      bjGames.delete(gameId);
      collector.stop('done');

      const fresh = await getUser(userId);
      let color, title, coinsText;

      if (dealerFinal > 21 || playerFinal > dealerFinal) {
        let win = Math.floor(bet * 2 * game.riskMult);
        win = applyGambler(fresh, win);
        fresh.balance += win;
        await recordWin(fresh, win - bet);
        color = '#00FF88'; title = `🏆  You Win!${riskTag}`;
        coinsText = `**+${fmt(win)}** coins`;
      } else if (playerFinal === dealerFinal) {
        fresh.balance += bet;
        await saveUser(fresh);
        color = '#FFD700'; title = '🤝  Push! (Tie)';
        coinsText = `Bet returned: **${fmt(bet)}** coins`;
      } else {
        const extra = bet * game.riskMult - bet;
        if (extra > 0) fresh.balance -= extra;
        await recordLoss(fresh, bet * game.riskMult);
        color = '#FF4444'; title = `💀  Dealer Wins!${riskTag}`;
        coinsText = `-${fmt(bet * game.riskMult)} coins`;
      }

      const finalEmbed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(SEP)
        .addFields(
          { name: '🃏 Your Hand',     value: `${fmtHand(game.playerHand)}  =  **${playerFinal}**` },
          { name: "🎴 Dealer's Hand", value: `${fmtHand(game.dealerHand)}  =  **${dealerFinal}**` },
          { name: '💰 Result',        value: coinsText },
          { name: '🏦 Balance',       value: `**${fmt(fresh.balance)}** coins` },
        );
      if (interaction) {
        return interaction.update({ embeds: [finalEmbed], components: [] });
      } else {
        return sentMsg.edit({ embeds: [finalEmbed], components: [] });
      }
    }

    collector.on('collect', async (ix) => {
      if (ix.user.id !== userId)
        return ix.reply({ content: "❌ This isn't your game!", ephemeral: true });
      const game = bjGames.get(gameId);
      if (!game) return;

      if (ix.customId === `bj_hit_${gameId}`) {
        game.playerHand.push(game.deck.pop());
        const val = handTotal(game.playerHand);
        if (val > 21) {
          const extra = bet * game.riskMult - bet;
          const fresh = await getUser(userId);
          if (extra > 0) fresh.balance -= extra;
          await recordLoss(fresh, bet * game.riskMult);
          activeGames.delete(userId);
          bjGames.delete(gameId);
          collector.stop('done');
          const bustEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle(`💥  Bust!${riskTag}`)
            .setDescription(SEP)
            .addFields(
              { name: '🃏 Your Hand',     value: `${fmtHand(game.playerHand)}  =  **${val}**` },
              { name: "🎴 Dealer's Hand", value: `${fmtHand(game.dealerHand)}  =  **${handTotal(game.dealerHand)}**` },
              { name: '💸 Lost',          value: `-${fmt(bet * game.riskMult)} coins` },
              { name: '🏦 Balance',       value: `**${fmt(fresh.balance)}** coins` },
            );
          return ix.update({ embeds: [bustEmbed], components: [] });
        }
        const updEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle(`🃏  Blackjack${riskTag}`)
          .setDescription(SEP)
          .addFields(
            { name: '🃏 Your Hand',        value: `${fmtHand(game.playerHand)}  =  **${val}**` },
            { name: "🎴 Dealer's Visible",  value: `${fmtCard(game.dealerHand[0])}  \`??\`` },
            { name: '💵 Bet',              value: `${fmt(bet)} coins` },
          )
          .setFooter({ text: 'Hit or Stand?' });
        return ix.update({ embeds: [updEmbed], components: [row] });
      }

      if (ix.customId === `bj_stand_${gameId}`) {
        while (handTotal(game.dealerHand) < 17) game.dealerHand.push(game.deck.pop());
        return resolveBJ(ix, handTotal(game.playerHand), handTotal(game.dealerHand), game);
      }
    });

    collector.on('end', (_, reason) => {
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
  //  ROULETTE  (!roulette <color> <bet>)
  //  colors: red/r  black/b  green/g
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'roulette' || command === 'rou') {
    // Accept: !roulette red 1000  OR  !roulette 1000 red
    let colorArg = args.find(a => ['red','r','black','b','green','g'].includes(a.toLowerCase()));
    let betArg   = args.find(a => !isNaN(parseInt(a)));
    if (!colorArg || !betArg) return message.reply('❌ Usage: `!roulette <red|black|green> <bet>`');

    const colorKey = colorArg[0].toLowerCase(); // r | b | g
    const bet      = parseInt(betArg);
    if (bet <= 0) return message.reply('❌ Bet must be positive.');

    const colorData = {
      r: { label: '🔴 Red',   prob: 0.45, payout: 2  },
      b: { label: '⚫ Black', prob: 0.45, payout: 2  },
      g: { label: '🟢 Green', prob: 0.10, payout: 10 },
    };
    const chosen = colorData[colorKey];

    const u = await getUser(userId);
    if (u.balance < bet) return message.reply(`❌ Need **${fmt(bet)}** coins, you have **${fmt(u.balance)}**.`);

    // Risk token
    const riskActive = !!armedRisk.get(userId);
    let riskConsumed = false;
    if (riskActive) {
      if ((u.inventory.riskTokens || 0) > 0) {
        u.inventory.riskTokens -= 1;
        riskConsumed = true;
      }
      armedRisk.delete(userId);
    }
    const riskMult = riskConsumed ? 5 : 1;
    const riskTag  = riskConsumed ? '  🔥 **5× RISK**' : '';

    u.balance -= bet;
    await saveUser(u);

    // Spin animation
    const wheelFrames = ['🔴','⚫','🟢','🔴','⚫','🟢'];
    const spinMsg = await message.reply({
      embeds: [new EmbedBuilder().setColor('#FFD700').setTitle(`🎡  Roulette${riskTag}`)
        .setDescription(`${SEP}\n🎯 You bet **${fmt(bet)}** on **${chosen.label}**\n\n⏳ Spinning...\n${SEP}`)]
    });

    for (let i = 0; i < 4; i++) {
      await sleep(600);
      const frame = wheelFrames[i % wheelFrames.length];
      await spinMsg.edit({
        embeds: [new EmbedBuilder().setColor('#FFD700').setTitle(`🎡  Roulette${riskTag}`)
          .setDescription(`${SEP}\n🎯 You bet **${fmt(bet)}** on **${chosen.label}**\n\n${frame} Spinning...\n${SEP}`)]
      });
    }

    // Determine result
    const roll = Math.random();
    let resultKey;
    if (roll < 0.45)       resultKey = 'r';
    else if (roll < 0.90)  resultKey = 'b';
    else                   resultKey = 'g';

    const resultColor = colorData[resultKey];
    const won = resultKey === colorKey;

    const fresh = await getUser(userId);
    let net, coinsText, resultTitle, embedColor;

    if (won) {
      let win = Math.floor(bet * chosen.payout * riskMult);
      win = applyGambler(fresh, win);
      fresh.balance += win;
      net = win - bet;
      await recordWin(fresh, net);
      resultTitle = `🏆  Winner!${riskTag}`;
      coinsText   = `**+${fmt(win)}** coins  *(net: +${fmt(net)})*`;
      embedColor  = '#00FF88';
    } else {
      const extra = bet * riskMult - bet;
      if (extra > 0) fresh.balance -= extra;
      net = -(bet * riskMult);
      await recordLoss(fresh, bet * riskMult);
      resultTitle = `💀  Better Luck Next Time!${riskTag}`;
      coinsText   = `-${fmt(bet * riskMult)} coins`;
      embedColor  = '#FF4444';
    }

    const resultEmbed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(`🎡  ${resultTitle}`)
      .setDescription(`${SEP}`)
      .addFields(
        { name: '🎯 Your Bet',    value: `**${chosen.label}**  •  **${fmt(bet)}** coins`,        inline: true },
        { name: '🎡 Ball Landed', value: `**${resultColor.label}**`,                              inline: true },
        { name: '💰 Result',      value: coinsText },
        { name: '🏦 Balance',     value: `**${fmt(fresh.balance)}** coins`,                       inline: true },
        { name: '🔥 Win Streak',  value: `${fresh.winStreak}`,                                   inline: true },
      )
      .setFooter({ text: `Odds: Red 45% • Black 45% • Green 10%  |  Payout: Red/Black 2× • Green 10×` });

    await sleep(500);
    return spinMsg.edit({ embeds: [resultEmbed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  SLOTS
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'slots') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!slots <bet>`');

    const u = await getUser(userId);
    if (u.balance < bet) return message.reply(`❌ Need **${fmt(bet)}** coins, you have **${fmt(u.balance)}**.`);

    u.balance -= bet;
    await saveUser(u);

    const symbols  = ['🍒','🍋','🍊','🍇','⭐','🔔','💎','7️⃣'];
    let   weights  = [28,  24,  18,  14,  8,   5,   2,   1  ];

    // Lucky Charm: boost all weights slightly
    if (u.inventory?.luckyCharm) weights = weights.map((w, i) => w + (i >= 4 ? 1 : 0));

    function weightedPick() {
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < symbols.length; i++) { r -= weights[i]; if (r <= 0) return symbols[i]; }
      return symbols[symbols.length - 1];
    }

    const reels = [weightedPick(), weightedPick(), weightedPick()];
    let multiplier = 0, resultText = '', isJackpot = false;

    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      if      (reels[0] === '7️⃣') { multiplier = 100; resultText = '🎰 **JACKPOT! Triple 7s! 100×!**'; isJackpot = true; }
      else if (reels[0] === '💎') { multiplier = 50;  resultText = '💎 **Triple Diamonds! 50×!**'; }
      else if (reels[0] === '⭐') { multiplier = 20;  resultText = '⭐ **Triple Stars! 20×!**'; }
      else if (reels[0] === '🔔') { multiplier = 10;  resultText = '🔔 **Triple Bells! 10×!**'; }
      else                         { multiplier = 5;   resultText = `${reels[0]} **Triple match! 5×!**`; }
    } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
      multiplier = 2; resultText = '✨ **Two of a kind! 2×!**';
    } else {
      resultText = '💔 No match.';
    }

    const fresh = await getUser(userId);
    let win = multiplier > 0 ? Math.floor(bet * multiplier) : 0;
    win = applyGambler(fresh, win);
    const net = win - bet;

    if (win > 0) {
      fresh.balance += win;
      await recordWin(fresh, net);
    } else {
      await recordLoss(fresh, bet);
    }

    const streakMsg = fresh.winStreak >= 5
      ? `\n🔥 **${fresh.winStreak}-game win streak!**`
      : fresh.winStreak >= 3
        ? `\n✨ ${fresh.winStreak} in a row!`
        : '';

    const embed = new EmbedBuilder()
      .setColor(multiplier > 0 ? '#FFD700' : '#FF4444')
      .setTitle('🎰  Slots')
      .setDescription(`${SEP}\n\`\`\`\n│  ${reels.join('  │  ')}  │\n\`\`\`\n${SEP}`)
      .addFields(
        { name: '🎲 Result', value: resultText + streakMsg },
        { name: '💰 Net',    value: net >= 0 ? `**+${fmt(net)}** coins` : `-${fmt(Math.abs(net))} coins` },
        { name: '🏦 Balance',value: `**${fmt(fresh.balance)}** coins`, inline: true },
        { name: '🔥 Streak', value: `${fresh.winStreak} wins`,         inline: true },
      )
      .setFooter({ text: u.inventory?.luckyCharm ? '🍀 Lucky Charm active!' : 'Try your luck again!' });

    // Jackpot broadcast
    if (isJackpot && JACKPOT_CHANNEL) {
      const ch = client.channels.cache.get(JACKPOT_CHANNEL);
      if (ch) ch.send({ embeds: [
        new EmbedBuilder().setColor('#FFD700')
          .setTitle('🎰  JACKPOT ALERT!')
          .setDescription(`🎉 <@${userId}> just hit **Triple 7s** in Slots and won **${fmt(win)}** coins!\n🏆 *Will you be next?*`)
      ]}).catch(() => {});
    }

    return message.reply({ embeds: [embed] });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  SUPER SLOTS  (7×3 grid)
  // ─────────────────────────────────────────────────────────────────────────
  if (command === 'superslots' || command === 'ss') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!superslots <bet>`');

    const u = await getUser(userId);
    const cd = u.inventory?.fastCooldown ? SS_FAST_CD : SS_BASE_CD;
    const elapsed = Date.now() - (u.lastSuperSlots || 0);
    if (elapsed < cd) {
      const rem = ((cd - elapsed) / 1000).toFixed(1);
      return message.reply(`⏳ Super Slots cooldown: **${rem}s** remaining.${u.inventory?.fastCooldown ? '' : '\n💡 Buy **⚡ Fast Cooldown** in `!shop` to reduce to 5s!'}`);
    }
    if (u.balance < bet) return message.reply(`❌ Need **${fmt(bet)}** coins, you have **${fmt(u.balance)}**.`);

    u.lastSuperSlots = Date.now();
    u.balance -= bet;
    await saveUser(u);

    const ROWS = 7, COLS = 3;
    const symbols = ['🍒','🍋','🍊','🍇','⭐','🔔','💰','7️⃣','👑'];
    const DIAMOND_CHANCE = 0.008; // ~0.8% per row

    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      if (Math.random() < DIAMOND_CHANCE) {
        grid.push(['💎','💎','💎']);
      } else {
        const sym = symbols[Math.floor(Math.random() * symbols.length)];
        const row = Array.from({ length: COLS }, () =>
          Math.random() < 0.30 ? sym : symbols[Math.floor(Math.random() * symbols.length)]
        );
        grid.push(row);
      }
    }

    // Row multipliers indexed by winning row count (0-7)
    const rowMults = [0, 1, 3, 8, 25, 100, 500, 5000];
    let winRows = 0, diamondRows = 0;

    for (const row of grid) {
      if (row.every(s => s === row[0])) {
        if (row[0] === '💎') diamondRows++;
        else                  winRows++;
      }
    }

    const baseMult     = rowMults[Math.min(winRows, 7)];
    const diamondBonus = diamondRows * 1000;
    const totalMult    = baseMult + diamondBonus;

    const fresh = await getUser(userId);
    let win = totalMult > 0 ? Math.floor(bet * totalMult) : 0;
    win = applyGambler(fresh, win);
    const net = win - bet;

    if (win > 0) {
      fresh.balance += win;
      await recordWin(fresh, net);
    } else {
      await recordLoss(fresh, bet);
    }

    // Build grid display (7 rows × 3 cols)
    const gridLines = grid.map(row => {
      const allSame = row.every(s => s === row[0]);
      const tick    = allSame ? '✅' : '▪️';
      return `${tick}  ${row.join('  ')}`;
    }).join('\n');

    let resultText = '';
    if (!winRows && !diamondRows) {
      resultText = '💔 No winning rows.';
    } else {
      if (winRows    > 0) resultText += `🎰 **${winRows}** winning row${winRows > 1 ? 's' : ''} → **${baseMult}×**\n`;
      if (diamondRows> 0) resultText += `💎 **${diamondRows}** Diamond row${diamondRows > 1 ? 's' : ''} → **+${diamondBonus}× BONUS!**\n`;
      resultText += `\n🏁 Total: **${totalMult}×**`;
    }

    // Achievement
    if (diamondRows > 0 && !(fresh.achievements || []).includes('DIAMOND_ROW')) {
      fresh.achievements = [...(fresh.achievements || []), 'DIAMOND_ROW'];
      await saveUser(fresh);
    }

    // Jackpot broadcast for huge wins
    if (totalMult >= 500 && JACKPOT_CHANNEL) {
      const ch = client.channels.cache.get(JACKPOT_CHANNEL);
      if (ch) ch.send({ embeds: [
        new EmbedBuilder().setColor('#FF00FF')
          .setTitle('💎  SUPER SLOTS MEGA WIN!')
          .setDescription(`<@${userId}> hit **${totalMult}×** in Super Slots and won **${fmt(win)}** coins! 🤯`)
      ]}).catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setColor(totalMult > 0 ? '#FFD700' : '#FF4444')
      .setTitle('💎  SUPER SLOTS  —  7×3')
      .setDescription(`${SEP}\n\`\`\`\n${gridLines}\n\`\`\`\n${SEP}`)
      .addFields(
        { name: '🎲 Result',    value: resultText },
        { name: '💰 Net',       value: net >= 0 ? `**+${fmt(net)}** coins` : `-${fmt(Math.abs(net))} coins` },
        { name: '🏦 Balance',   value: `**${fmt(fresh.balance)}** coins`, inline: true },
        { name: '⏱ Cooldown',  value: `${cd / 1000}s`,                   inline: true },
      )
      .setFooter({ text: '✅ = winning row  |  💎 Diamond row = +1000× bonus  |  Multipliers: 1row=1× 2=3× 3=8× 4=25× 5=100× 6=500× 7=5000×' });

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
        { name: '💰 Economy',
          value: '`!balance` / `!bal` — View your balance & stats\n`!daily` — Claim daily reward (streak bonuses!)\n`!profile [@user]` — Full casino profile\n`!inventory` — View owned items\n`!leaderboard` / `!top` — Top 10 richest' },
        { name: '🛒 Shop',
          value: '`!shop` — Browse & buy items\n`!userisk` / `!arm` — Arm a 🔥 Risk Token for next BJ/Roulette\n`!opencrate` / `!crate` — Open a 📦 Mystery Crate' },
        { name: '🃏 Blackjack',
          value: '`!blackjack <bet>` / `!bj <bet>`\n• Natural BJ pays **2.5×** • Win pays **2×**\n• Risk Token = 5× win/loss' },
        { name: '🎡 Roulette',
          value: '`!roulette <red|black|green> <bet>`\n• Red/Black = **2×** (45% each)\n• Green = **10×** (10%)\n• Risk Token = 5× win/loss' },
        { name: '🎰 Slots',
          value: '`!slots <bet>`\n• 2 of a kind = **2×** • Triple = **5×**\n• Triple Bells = **10×** • Triple Stars = **20×**\n• Triple Diamonds = **50×** • Triple 7s = **100×**' },
        { name: '💎 Super Slots',
          value: '`!superslots <bet>` / `!ss <bet>`\n• 7-row × 3-col grid • 20s cooldown (5s with ⚡)\n• 1row=**1×** 2=**3×** 3=**8×** 4=**25×** 5=**100×** 6=**500×** 7=**5000×**\n• 💎 Diamond row = **+1000×** bonus (ultra rare!)' },
      )
      .setFooter({ text: 'Good luck! 🍀  |  Use !profile to track your stats' });
    return message.reply({ embeds: [embed] });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  await mongoose.connect(MONGO);
  console.log('✅  MongoDB connected');
  await client.login(TOKEN);
}

main().catch(err => { console.error('❌  Boot error:', err); process.exit(1); });
