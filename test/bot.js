const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ── DATA LAYER ───────────────────────────────────────────────────────────
const DATA_FILE = './data/economy.json';
function loadData() {
  if (!fs.existsSync('./data')) fs.mkdirSync('./data');
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(DATA_FILE));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function defaultUser() {
  return {
    balance: 1000,
    totalWon: 0,
    totalLost: 0,
    lastDaily: 0,
    lastSuperSlots: 0,
    hasGamblerRole: false,
    hasFastCooldown: false,
    riskItems: 0, // 5x risk item count
  };
}
function getUser(userId) {
  const data = loadData();
  if (!data[userId]) data[userId] = defaultUser();
  // backfill any new fields for existing users
  data[userId] = { ...defaultUser(), ...data[userId] };
  saveData(data);
  return data[userId];
}
function saveUser(userId, userObj) {
  const data = loadData();
  data[userId] = userObj;
  saveData(data);
}

// Applies the gambler role multiplier (1.1x) to a winnings amount.
// Only applied to positive winnings credited to the player, not losses.
function applyGamblerMultiplier(user, amount) {
  if (amount > 0 && user.hasGamblerRole) {
    return Math.floor(amount * 1.1);
  }
  return amount;
}

function updateBalance(userId, amount) {
  const data = loadData();
  if (!data[userId]) data[userId] = defaultUser();
  data[userId].balance += amount;
  if (amount > 0) data[userId].totalWon += amount;
  else data[userId].totalLost += Math.abs(amount);
  saveData(data);
  return data[userId];
}

// ── SHOP CONFIG ──────────────────────────────────────────────────────────
const SHOP_ITEMS = {
  fastcooldown: {
    name: '⚡ Fast Cooldown',
    desc: 'Lowers Super Slots cooldown from 20s to 5s (permanent)',
    price: 10000000,
    type: 'permanent_flag',
    flag: 'hasFastCooldown',
  },
  gambler: {
    name: '🎩 Gambler Role',
    desc: 'All winnings across every game are multiplied by 1.1x (permanent)',
    price: 50000000,
    type: 'permanent_flag',
    flag: 'hasGamblerRole',
  },
  riskitem: {
    name: '🔥 5x Risk Token',
    desc: 'Consumable. Use before Blackjack/Roulette: 5x your win OR 5x your loss. High risk, high reward.',
    price: 2500000,
    type: 'consumable',
    flag: 'riskItems',
  },
};

const SUPERSLOTS_BASE_CD = 20000; // 20s
const SUPERSLOTS_FAST_CD = 5000;  // 5s

const activeGames = new Map();
// Tracks whether a user has an "armed" risk token active for their next bj/roulette round
const armedRisk = new Map(); // userId -> true/false
// Tracks per-user pending buy quantity for the risk token (default 1)
const riskBuyQty = new Map(); // userId -> number

function buildShopEmbed(user) {
  return new EmbedBuilder()
    .setColor('#9B59B6')
    .setTitle('🛒 Item Shop')
    .setDescription('Click a button below to purchase instantly.')
    .addFields(
      {
        name: `${SHOP_ITEMS.fastcooldown.name} — ${SHOP_ITEMS.fastcooldown.price.toLocaleString()} coins`,
        value: `${SHOP_ITEMS.fastcooldown.desc}${user.hasFastCooldown ? '\n✅ **OWNED**' : ''}`
      },
      {
        name: `${SHOP_ITEMS.gambler.name} — ${SHOP_ITEMS.gambler.price.toLocaleString()} coins`,
        value: `${SHOP_ITEMS.gambler.desc}${user.hasGamblerRole ? '\n✅ **OWNED**' : ''}`
      },
      {
        name: `${SHOP_ITEMS.riskitem.name} — ${SHOP_ITEMS.riskitem.price.toLocaleString()} coins each`,
        value: `${SHOP_ITEMS.riskitem.desc}\nOwned: **${user.riskItems}**`
      },
      { name: '💰 Your Balance', value: `${user.balance.toLocaleString()} coins` }
    )
    .setFooter({ text: 'Permanent items can only be bought once. Risk tokens stack — use +/- to set quantity.' });
}

function buildShopComponents(user, qty = 1) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_buy_fastcooldown')
      .setLabel(user.hasFastCooldown ? 'Owned ✅' : `Buy Fast Cooldown (${SHOP_ITEMS.fastcooldown.price.toLocaleString()})`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji('⚡')
      .setDisabled(user.hasFastCooldown),
    new ButtonBuilder()
      .setCustomId('shop_buy_gambler')
      .setLabel(user.hasGamblerRole ? 'Owned ✅' : `Buy Gambler Role (${SHOP_ITEMS.gambler.price.toLocaleString()})`)
      .setStyle(ButtonStyle.Success)
      .setEmoji('🎩')
      .setDisabled(user.hasGamblerRole)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('shop_qty_minus').setLabel('−').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shop_qty_display').setLabel(`Qty: ${qty}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('shop_qty_plus').setLabel('+').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('shop_buy_riskitem')
      .setLabel(`Buy Risk Token (${(SHOP_ITEMS.riskitem.price * qty).toLocaleString()})`)
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔥')
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('shop_arm_risk')
      .setLabel('Arm Risk Token for Next Round')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🎯')
      .setDisabled(user.riskItems <= 0)
  );

  return [row1, row2, row3];
}

function attachShopCollector(msg, ownerId) {
  riskBuyQty.set(ownerId, 1);
  const collector = msg.createMessageComponentCollector({ time: 120000 });

  collector.on('collect', async (interaction) => {
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "❌ This isn't your shop menu! Use `!shop` to open your own.", ephemeral: true });
    }

    const user = getUser(ownerId);
    let qty = riskBuyQty.get(ownerId) || 1;

    if (interaction.customId === 'shop_qty_minus') {
      qty = Math.max(1, qty - 1);
      riskBuyQty.set(ownerId, qty);
      return interaction.update({ embeds: [buildShopEmbed(user)], components: buildShopComponents(user, qty) });
    }

    if (interaction.customId === 'shop_qty_plus') {
      qty = Math.min(99, qty + 1);
      riskBuyQty.set(ownerId, qty);
      return interaction.update({ embeds: [buildShopEmbed(user)], components: buildShopComponents(user, qty) });
    }

    if (interaction.customId === 'shop_buy_fastcooldown') {
      const item = SHOP_ITEMS.fastcooldown;
      if (user.hasFastCooldown) return interaction.reply({ content: `❌ You already own **${item.name}**.`, ephemeral: true });
      if (user.balance < item.price) return interaction.reply({ content: `❌ Not enough coins! Need **${item.price.toLocaleString()}**, you have **${user.balance.toLocaleString()}**.`, ephemeral: true });
      user.balance -= item.price;
      user.hasFastCooldown = true;
      saveUser(ownerId, user);
      await interaction.reply({ content: `✅ Purchased **${item.name}**! Super Slots cooldown is now 5s.`, ephemeral: true });
      return interaction.message.edit({ embeds: [buildShopEmbed(user)], components: buildShopComponents(user, qty) });
    }

    if (interaction.customId === 'shop_buy_gambler') {
      const item = SHOP_ITEMS.gambler;
      if (user.hasGamblerRole) return interaction.reply({ content: `❌ You already own **${item.name}**.`, ephemeral: true });
      if (user.balance < item.price) return interaction.reply({ content: `❌ Not enough coins! Need **${item.price.toLocaleString()}**, you have **${user.balance.toLocaleString()}**.`, ephemeral: true });
      user.balance -= item.price;
      user.hasGamblerRole = true;
      saveUser(ownerId, user);
      await interaction.reply({ content: `✅ Purchased **${item.name}**! All your winnings are now multiplied by 1.1x.`, ephemeral: true });
      return interaction.message.edit({ embeds: [buildShopEmbed(user)], components: buildShopComponents(user, qty) });
    }

    if (interaction.customId === 'shop_buy_riskitem') {
      const item = SHOP_ITEMS.riskitem;
      const totalCost = item.price * qty;
      if (user.balance < totalCost) return interaction.reply({ content: `❌ Not enough coins! **${qty}x ${item.name}** costs **${totalCost.toLocaleString()}**, you have **${user.balance.toLocaleString()}**.`, ephemeral: true });
      user.balance -= totalCost;
      user.riskItems += qty;
      saveUser(ownerId, user);
      await interaction.reply({ content: `✅ Purchased **${qty}x ${item.name}**! You now own **${user.riskItems}**.`, ephemeral: true });
      return interaction.message.edit({ embeds: [buildShopEmbed(user)], components: buildShopComponents(user, qty) });
    }

    if (interaction.customId === 'shop_arm_risk') {
      if (user.riskItems <= 0) return interaction.reply({ content: '❌ You have no 🔥 Risk Tokens.', ephemeral: true });
      if (armedRisk.get(ownerId)) return interaction.reply({ content: '⚠️ You already have a Risk Token armed for your next round.', ephemeral: true });
      armedRisk.set(ownerId, true);
      return interaction.reply({ content: '🔥 **Risk Token armed!** Your next Blackjack or Roulette round will have its win/loss multiplied by **5x**.', ephemeral: true });
    }
  });

  collector.on('end', () => {
    riskBuyQty.delete(ownerId);
    msg.edit({ components: [] }).catch(() => {});
  });
}

client.once('ready', () => {
  console.log(`✅ ${client.user.tag} is online!`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const userId = message.author.id;

  // ── BALANCE ────────────────────────────────────────────────────────────
  if (command === 'balance' || command === 'bal') {
    const user = getUser(userId);
    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('💰 Your Balance')
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: '💵 Balance', value: `**${user.balance.toLocaleString()}** coins`, inline: true },
        { name: '📈 Total Won', value: `${user.totalWon.toLocaleString()} coins`, inline: true },
        { name: '📉 Total Lost', value: `${user.totalLost.toLocaleString()} coins`, inline: true },
        { name: '🎩 Gambler Role', value: user.hasGamblerRole ? '✅ Active (1.1x winnings)' : '❌ Not owned', inline: true },
        { name: '⚡ Fast Cooldown', value: user.hasFastCooldown ? '✅ Active (5s CD)' : '❌ Not owned (20s CD)', inline: true },
        { name: '🔥 Risk Tokens', value: `${user.riskItems}`, inline: true }
      )
      .setFooter({ text: message.author.username });
    return message.reply({ embeds: [embed] });
  }

  // ── DAILY ──────────────────────────────────────────────────────────────
  if (command === 'daily') {
    const user = getUser(userId);
    const now = Date.now();
    if (now - user.lastDaily < 86400000) {
      const remaining = 86400000 - (now - user.lastDaily);
      const hrs = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return message.reply(`⏳ Daily already claimed! Come back in **${hrs}h ${mins}m**.`);
    }
    user.lastDaily = now;
    user.balance += 500;
    user.totalWon += 500;
    saveUser(userId, user);
    const embed = new EmbedBuilder()
      .setColor('#00FF88')
      .setTitle('🎁 Daily Reward!')
      .setDescription(`You received **500 coins**! New balance: **${user.balance.toLocaleString()}**`);
    return message.reply({ embeds: [embed] });
  }

  // ── SHOP (button-based) ──────────────────────────────────────────────────
  if (command === 'shop') {
    const user = getUser(userId);

    const embed = buildShopEmbed(user);
    const components = buildShopComponents(user);

    const msg = await message.reply({ embeds: [embed], components });
    attachShopCollector(msg, userId);
    return;
  }

  // ── USE RISK TOKEN (arm it before next blackjack/roulette round) ────────
  if (command === 'userisk' || command === 'arm') {
    const user = getUser(userId);
    if (user.riskItems <= 0) return message.reply('❌ You have no 🔥 Risk Tokens. Buy one with `!shop`.');
    if (armedRisk.get(userId)) return message.reply('⚠️ You already have a Risk Token armed for your next Blackjack or Roulette round.');
    armedRisk.set(userId, true);
    const embed = new EmbedBuilder()
      .setColor('#FF4500')
      .setTitle('🔥 Risk Token Armed!')
      .setDescription('Your next **Blackjack** or **Roulette** round will have its win/loss multiplied by **5x**.\nWin big — or lose big.')
      .addFields({ name: 'Risk Tokens Remaining', value: `${user.riskItems - 1}` });
    return message.reply({ embeds: [embed] });
  }

  // ── HELP ───────────────────────────────────────────────────────────────
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor('#7289DA')
      .setTitle('🎰 Gambling Bot Commands')
      .addFields(
        { name: '💰 Economy', value: '`!balance` — Check your coins\n`!daily` — Claim 500 daily coins' },
        { name: '🛒 Shop', value: '`!shop` — View shop items\n`!buy <item>` — Purchase an item\n`!userisk` — Arm a 5x Risk Token for your next BJ/Roulette round' },
        { name: '🃏 Blackjack', value: '`!blackjack <bet>` — Play Blackjack (2x win)' },
        { name: '🎡 Roulette', value: '`!roulette <bet> <r/g/b> [r/g/b] [r/g/b]` — Spin the wheel\n2 matches = 2x | 3 matches = 5x' },
        { name: '🎰 Slots', value: '`!slots <bet>` — Classic 3-reel slots' },
        { name: '💎 Super Slots', value: '`!superslots <bet>` — 7-row mega slots (20s cooldown, 5s with Fast Cooldown item)\n1 row=1x | 2=5x | 3=10x | 4=210x | 5=1000x | 6=40000x | 7=2.5Mx\nDiamond row 💎 = 5000x bonus (0.01% chance per row)' }
      )
      .setFooter({ text: 'Good luck! 🍀' });
    return message.reply({ embeds: [embed] });
  }

  // ── BLACKJACK ──────────────────────────────────────────────────────────
  if (command === 'blackjack' || command === 'bj') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!blackjack <bet>`');
    const user = getUser(userId);
    if (user.balance < bet) return message.reply(`❌ Not enough coins! You have **${user.balance}**.`);

    // Consume risk token if armed
    const riskActive = !!armedRisk.get(userId);
    let riskConsumed = false;
    if (riskActive) {
      const freshUser = getUser(userId);
      if (freshUser.riskItems > 0) {
        freshUser.riskItems -= 1;
        saveUser(userId, freshUser);
        riskConsumed = true;
      }
      armedRisk.delete(userId);
    }
    const riskMulti = riskConsumed ? 5 : 1;

    updateBalance(userId, -bet);

    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const deck = [];
    for (const s of suits) for (const v of values) deck.push({ s, v });
    deck.sort(() => Math.random() - 0.5);

    function cardValue(card) {
      if (['J', 'Q', 'K'].includes(card.v)) return 10;
      if (card.v === 'A') return 11;
      return parseInt(card.v);
    }
    function handValue(hand) {
      let total = hand.reduce((s, c) => s + cardValue(c), 0);
      let aces = hand.filter(c => c.v === 'A').length;
      while (total > 21 && aces > 0) { total -= 10; aces--; }
      return total;
    }
    function formatCard(c) { return `\`${c.v}${c.s}\``; }
    function formatHand(hand) { return hand.map(formatCard).join(' '); }

    let playerHand = [deck.pop(), deck.pop()];
    let dealerHand = [deck.pop(), deck.pop()];

    const gameId = `bj_${userId}_${Date.now()}`;
    activeGames.set(gameId, { deck, playerHand, dealerHand, bet, userId, riskMulti });

    const pVal = handValue(playerHand);
    const dVal = handValue(dealerHand);
    const riskTag = riskConsumed ? ' 🔥 **5x RISK ACTIVE**' : '';

    // Natural blackjack check
    if (pVal === 21) {
      let winnings = Math.floor(bet * 2 * riskMulti);
      const u = getUser(userId);
      winnings = applyGamblerMultiplier(u, winnings);
      updateBalance(userId, winnings);
      activeGames.delete(gameId);
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(`🃏 BLACKJACK! You win!${riskTag}`)
        .addFields(
          { name: 'Your Hand', value: `${formatHand(playerHand)} = **${pVal}**` },
          { name: "Dealer's Hand", value: `${formatHand(dealerHand)} = **${dVal}**` },
          { name: '💰 Winnings', value: `+**${winnings.toLocaleString()}** coins` }
        );
      return message.reply({ embeds: [embed] });
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bj_hit_${gameId}`).setLabel('HIT').setStyle(ButtonStyle.Primary).setEmoji('👊'),
      new ButtonBuilder().setCustomId(`bj_stand_${gameId}`).setLabel('STAND').setStyle(ButtonStyle.Secondary).setEmoji('✋')
    );

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle(`🃏 Blackjack${riskTag}`)
      .addFields(
        { name: 'Your Hand', value: `${formatHand(playerHand)} = **${pVal}**` },
        { name: "Dealer's Hand", value: `${formatCard(dealerHand[0])} \`??\`` },
        { name: '💵 Bet', value: `${bet} coins` }
      )
      .setFooter({ text: 'Hit or Stand?' });

    const msg = await message.reply({ embeds: [embed], components: [row] });

    const collector = msg.createMessageComponentCollector({ time: 60000 });
    collector.on('collect', async (interaction) => {
      if (interaction.user.id !== userId) {
        return interaction.reply({ content: "❌ This isn't your game!", ephemeral: true });
      }
      const game = activeGames.get(gameId);
      if (!game) return;

      if (interaction.customId === `bj_hit_${gameId}`) {
        game.playerHand.push(game.deck.pop());
        const newVal = handValue(game.playerHand);

        if (newVal > 21) {
          activeGames.delete(gameId);
          collector.stop();
          const lossAmt = bet * game.riskMulti - bet; // additional loss beyond initial bet already deducted
          if (lossAmt > 0) updateBalance(userId, -lossAmt);
          const totalLoss = bet * game.riskMulti;
          const loseEmbed = new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle(`💥 Bust! You lose!${riskTag}`)
            .addFields(
              { name: 'Your Hand', value: `${formatHand(game.playerHand)} = **${newVal}**` },
              { name: "Dealer's Hand", value: `${formatHand(game.dealerHand)} = **${handValue(game.dealerHand)}**` },
              { name: '💸 Lost', value: `-${totalLoss.toLocaleString()} coins` }
            );
          return interaction.update({ embeds: [loseEmbed], components: [] });
        }

        const hitEmbed = new EmbedBuilder()
          .setColor('#FFD700')
          .setTitle(`🃏 Blackjack${riskTag}`)
          .addFields(
            { name: 'Your Hand', value: `${formatHand(game.playerHand)} = **${newVal}**` },
            { name: "Dealer's Hand", value: `${formatCard(game.dealerHand[0])} \`??\`` },
            { name: '💵 Bet', value: `${bet} coins` }
          );
        return interaction.update({ embeds: [hitEmbed], components: [row] });
      }

      if (interaction.customId === `bj_stand_${gameId}`) {
        while (handValue(game.dealerHand) < 17) game.dealerHand.push(game.deck.pop());
        const pFinal = handValue(game.playerHand);
        const dFinal = handValue(game.dealerHand);
        activeGames.delete(gameId);
        collector.stop();

        let resultColor, resultTitle, coinsText;
        if (dFinal > 21 || pFinal > dFinal) {
          let winnings = Math.floor(bet * 2 * game.riskMulti);
          const u = getUser(userId);
          winnings = applyGamblerMultiplier(u, winnings);
          updateBalance(userId, winnings);
          resultColor = '#00FF00'; resultTitle = `🏆 You Win!${riskTag}`;
          coinsText = `+**${winnings.toLocaleString()}** coins`;
        } else if (pFinal === dFinal) {
          updateBalance(userId, bet);
          resultColor = '#FFD700'; resultTitle = '🤝 Push! (Tie)';
          coinsText = `Bet returned: **${bet.toLocaleString()}** coins`;
        } else {
          const extraLoss = bet * game.riskMulti - bet;
          if (extraLoss > 0) updateBalance(userId, -extraLoss);
          const totalLoss = bet * game.riskMulti;
          resultColor = '#FF0000'; resultTitle = `💀 Dealer Wins!${riskTag}`;
          coinsText = `-${totalLoss.toLocaleString()} coins`;
        }

        const finalEmbed = new EmbedBuilder()
          .setColor(resultColor)
          .setTitle(resultTitle)
          .addFields(
            { name: 'Your Hand', value: `${formatHand(game.playerHand)} = **${pFinal}**` },
            { name: "Dealer's Hand", value: `${formatHand(game.dealerHand)} = **${dFinal}**` },
            { name: '💰 Result', value: coinsText }
          );
        return interaction.update({ embeds: [finalEmbed], components: [] });
      }
    });

    collector.on('end', (_, reason) => {
      if (reason === 'time' && activeGames.has(gameId)) {
        activeGames.delete(gameId);
        msg.edit({ components: [] }).catch(() => {});
      }
    });
  }

  // ── ROULETTE ───────────────────────────────────────────────────────────
  if (command === 'roulette') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!roulette <bet> <r/g/b> [r/g/b] [r/g/b]`');
    if (args.length < 2) return message.reply('❌ Choose at least 1 color: `r` (red), `g` (green), `b` (blue)');

    const colorMap = { r: '🔴 Red', g: '🟢 Green', b: '🔵 Blue' };
    const choices = args.slice(1).map(c => c.toLowerCase()).filter(c => colorMap[c]);
    const uniqueChoices = [...new Set(choices)].slice(0, 3);
    if (uniqueChoices.length === 0) return message.reply('❌ Invalid colors. Use `r`, `g`, or `b`.');

    const user = getUser(userId);
    if (user.balance < bet) return message.reply(`❌ Not enough coins! You have **${user.balance}**.`);

    // Consume risk token if armed
    const riskActive = !!armedRisk.get(userId);
    let riskConsumed = false;
    if (riskActive) {
      if (user.riskItems > 0) {
        user.riskItems -= 1;
        riskConsumed = true;
      }
      armedRisk.delete(userId);
    }
    const riskMulti = riskConsumed ? 5 : 1;
    saveUser(userId, user);

    updateBalance(userId, -bet);

    const colors = ['r', 'g', 'b'];
    const spins = [
      colors[Math.floor(Math.random() * 3)],
      colors[Math.floor(Math.random() * 3)],
      colors[Math.floor(Math.random() * 3)]
    ];

    const matchCount = spins.filter(s => uniqueChoices.includes(s)).length;

    let baseMultiplier = 0;
    let resultText = '';
    if (matchCount >= 3) { baseMultiplier = 5; resultText = '🎉 3 MATCHES — **5x**!'; }
    else if (matchCount >= 2) { baseMultiplier = 2; resultText = '✨ 2 MATCHES — **2x**!'; }
    else { resultText = '💔 No matches.'; }

    const riskTag = riskConsumed ? ' 🔥 **5x RISK ACTIVE**' : '';
    let winnings = 0;
    let net;

    if (baseMultiplier > 0) {
      winnings = Math.floor(bet * baseMultiplier * riskMulti);
      const u = getUser(userId);
      winnings = applyGamblerMultiplier(u, winnings);
      updateBalance(userId, winnings);
      net = winnings - bet;
    } else {
      // Loss case: extra loss beyond initial bet if risk active
      const extraLoss = bet * riskMulti - bet;
      if (extraLoss > 0) updateBalance(userId, -extraLoss);
      net = -(bet * riskMulti);
    }

    const embed = new EmbedBuilder()
      .setColor(baseMultiplier > 0 ? '#00FF00' : '#FF0000')
      .setTitle(`🎡 Roulette${riskTag}`)
      .addFields(
        { name: 'Your Picks', value: uniqueChoices.map(c => colorMap[c]).join(', ') },
        { name: 'Wheel Spun', value: spins.map(s => colorMap[s]).join(' | ') },
        { name: 'Result', value: resultText },
        { name: '💰 Net', value: net >= 0 ? `+**${net.toLocaleString()}** coins` : `-**${Math.abs(net).toLocaleString()}** coins` }
      );
    return message.reply({ embeds: [embed] });
  }

  // ── SLOTS ──────────────────────────────────────────────────────────────
  if (command === 'slots') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!slots <bet>`');
    const user = getUser(userId);
    if (user.balance < bet) return message.reply(`❌ Not enough coins! You have **${user.balance}**.`);
    updateBalance(userId, -bet);

    const symbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
    const weights = [30, 25, 20, 15, 6, 3, 1];
    function weightedRandom() {
      let r = Math.random() * 100;
      for (let i = 0; i < symbols.length; i++) {
        r -= weights[i];
        if (r <= 0) return symbols[i];
      }
      return symbols[symbols.length - 1];
    }

    const reels = [weightedRandom(), weightedRandom(), weightedRandom()];
    let multiplier = 0;
    let resultText = '';

    if (reels[0] === reels[1] && reels[1] === reels[2]) {
      if (reels[0] === '7️⃣') { multiplier = 100; resultText = '🎰 JACKPOT! Triple 7s! **100x**!'; }
      else if (reels[0] === '💎') { multiplier = 50; resultText = '💎 Triple Diamonds! **50x**!'; }
      else if (reels[0] === '⭐') { multiplier = 20; resultText = '⭐ Triple Stars! **20x**!'; }
      else { multiplier = 5; resultText = `Triple ${reels[0]}! **5x**!`; }
    } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
      multiplier = 2; resultText = 'Two of a kind! **2x**!';
    } else {
      resultText = 'No match. Better luck next time!';
    }

    let winnings = multiplier > 0 ? bet * multiplier : 0;
    if (winnings > 0) {
      const u = getUser(userId);
      winnings = applyGamblerMultiplier(u, winnings);
      updateBalance(userId, winnings);
    }
    const net = winnings - bet;

    const embed = new EmbedBuilder()
      .setColor(multiplier > 0 ? '#FFD700' : '#FF4444')
      .setTitle('🎰 Slots')
      .setDescription(`\`\`\`\n[ ${reels.join(' | ')} ]\n\`\`\``)
      .addFields(
        { name: 'Result', value: resultText },
        { name: '💰 Net', value: net >= 0 ? `+**${net.toLocaleString()}** coins` : `-**${Math.abs(net).toLocaleString()}** coins` }
      );
    return message.reply({ embeds: [embed] });
  }

  // ── SUPER SLOTS ────────────────────────────────────────────────────────
  if (command === 'superslots' || command === 'ss') {
    const bet = parseInt(args[0]);
    if (isNaN(bet) || bet <= 0) return message.reply('❌ Usage: `!superslots <bet>`');
    const user = getUser(userId);
    if (user.balance < bet) return message.reply(`❌ Not enough coins! You have **${user.balance}**.`);

    // Cooldown check
    const cdLength = user.hasFastCooldown ? SUPERSLOTS_FAST_CD : SUPERSLOTS_BASE_CD;
    const now = Date.now();
    const elapsed = now - (user.lastSuperSlots || 0);
    if (elapsed < cdLength) {
      const remaining = ((cdLength - elapsed) / 1000).toFixed(1);
      return message.reply(`⏳ Super Slots is on cooldown! Wait **${remaining}s**.${user.hasFastCooldown ? '' : ' (Buy `fastcooldown` in `!shop` to lower this to 5s!)'}`);
    }
    user.lastSuperSlots = now;
    saveUser(userId, user);

    updateBalance(userId, -bet);

    const ROWS = 7;
    const COLS = 5;
    const symbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '🔔', '💰', '7️⃣', '👑'];
    const DIAMOND_CHANCE = 0.01;

    const grid = [];
    for (let r = 0; r < ROWS; r++) {
      if (Math.random() < DIAMOND_CHANCE) {
        grid.push(['💎', '💎', '💎', '💎', '💎']);
      } else {
        const sym = symbols[Math.floor(Math.random() * symbols.length)];
        const row = Array.from({ length: COLS }, () =>
          Math.random() < 0.35 ? sym : symbols[Math.floor(Math.random() * symbols.length)]
        );
        grid.push(row);
      }
    }

    const rowMultipliers = [0, 1, 5, 10, 210, 1000, 40000, 2500000];
    let winningRows = 0;
    let diamondWinRows = 0;

    for (const row of grid) {
      const allSame = row.every(s => s === row[0]);
      if (allSame) {
        if (row[0] === '💎') diamondWinRows++;
        else winningRows++;
      }
    }

    const baseMultiplier = rowMultipliers[Math.min(winningRows, 7)];
    const diamondBonus = diamondWinRows > 0 ? 5000 * diamondWinRows : 0;
    const totalMultiplier = baseMultiplier + diamondBonus;

    let winnings = totalMultiplier > 0 ? Math.floor(bet * totalMultiplier) : 0;
    if (winnings > 0) {
      const u = getUser(userId);
      winnings = applyGamblerMultiplier(u, winnings);
      updateBalance(userId, winnings);
    }
    const net = winnings - bet;

    const gridText = grid.map((row) => {
      const allSame = row.every(s => s === row[0]);
      const prefix = allSame ? '✅' : '  ';
      return `${prefix} ${row.join(' ')}`;
    }).join('\n');

    let resultText = '';
    if (winningRows === 0 && diamondWinRows === 0) resultText = 'No winning rows. 😔';
    else {
      if (winningRows > 0) resultText += `🎰 **${winningRows}** winning row${winningRows > 1 ? 's' : ''} → **${baseMultiplier}x**\n`;
      if (diamondWinRows > 0) resultText += `💎 **${diamondWinRows}** DIAMOND row${diamondWinRows > 1 ? 's' : ''} → **+${5000 * diamondWinRows}x BONUS**!\n`;
      resultText += `Total multiplier: **${totalMultiplier}x**`;
    }

    const embed = new EmbedBuilder()
      .setColor(totalMultiplier > 0 ? '#FFD700' : '#FF4444')
      .setTitle('💎 SUPER SLOTS — 7 Rows')
      .setDescription(`\`\`\`\n${gridText}\n\`\`\``)
      .addFields(
        { name: 'Result', value: resultText },
        { name: '💰 Net', value: net >= 0 ? `+**${net.toLocaleString()}** coins` : `-**${Math.abs(net).toLocaleString()}** coins` }
      )
      .setFooter({ text: `✅ = winning row | 💎 Diamond row = 5000x bonus | CD: ${cdLength/1000}s` });
    return message.reply({ embeds: [embed] });
  }
});

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌ No DISCORD_TOKEN found in environment variables!');
  console.log('Set it with: export DISCORD_TOKEN=your_token_here');
  process.exit(1);
}
client.login(TOKEN);
