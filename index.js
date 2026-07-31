const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  getContentType,
  downloadContentFromMessage,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const express = require('express');

const config = require('./config');
const db = require('./lib/db');
const { ctx, runtime } = require('./lib/function');

const logger = pino({ level: 'silent' });
const msgRetryCounterCache = new NodeCache();
const SESSION_DIR = path.join(__dirname, 'session');

/* ---------- SESSION_ID (base64 creds) support ---------- */
function restoreSession() {
  if (!config.SESSION_ID) return;
  const credsPath = path.join(SESSION_DIR, 'creds.json');
  if (fs.existsSync(credsPath)) return;
  try {
    let raw = config.SESSION_ID.replace(/^TAHA~|^DARKZONE~/i, '').trim();
    const json = Buffer.from(raw, 'base64').toString('utf8');
    JSON.parse(json); // validate
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(credsPath, json);
    console.log('✅ SESSION_ID loaded');
  } catch (e) {
    console.log('⚠️  SESSION_ID invalid — pairing code se connect karein');
  }
}

/* ---------- Plugin loader ---------- */
const commands = [];
function loadPlugins() {
  commands.length = 0;
  const dir = path.join(__dirname, 'plugins');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    try {
      delete require.cache[require.resolve(path.join(dir, file))];
      const plug = require(path.join(dir, file));
      (Array.isArray(plug) ? plug : [plug]).forEach(p => p?.name && commands.push(p));
    } catch (e) {
      console.log(`❌ Plugin error [${file}]:`, e.message);
    }
  }
  console.log(`✅ ${commands.length} commands loaded`);
}

/* ---------- Serialize message ---------- */
function serialize(sock, m) {
  if (!m.message) return null;
  const type = getContentType(m.message);
  const msg = m.message[type];

  const s = {};
  s.key = m.key;
  s.id = m.key.id;
  s.chat = m.key.remoteJid;
  s.isGroup = s.chat.endsWith('@g.us');
  s.fromMe = m.key.fromMe;
  s.sender = jidNormalizedUser(s.fromMe ? sock.user.id : (s.isGroup ? m.key.participant : s.chat));
  s.pushName = m.pushName || 'User';
  s.type = type;
  s.body =
    (type === 'conversation' && msg) ||
    msg?.text ||
    msg?.caption ||
    msg?.selectedButtonId ||
    msg?.singleSelectReply?.selectedRowId ||
    '';

  s.isOwner = s.sender.split('@')[0] === config.OWNER_NUMBER || s.fromMe;
  s.mentions = msg?.contextInfo?.mentionedJid || [];

  const q = msg?.contextInfo?.quotedMessage;
  if (q) {
    const qt = getContentType(q);
    s.quoted = {
      type: qt,
      key: {
        remoteJid: s.chat,
        id: msg.contextInfo.stanzaId,
        participant: msg.contextInfo.participant,
        fromMe: jidNormalizedUser(msg.contextInfo.participant) === jidNormalizedUser(sock.user.id),
      },
      message: q[qt],
      sender: jidNormalizedUser(msg.contextInfo.participant),
      body: q[qt]?.text || q[qt]?.caption || (qt === 'conversation' ? q[qt] : ''),
      download: async () => {
        const stream = await downloadContentFromMessage(q[qt], qt.replace('Message', ''));
        let buf = Buffer.from([]);
        for await (const c of stream) buf = Buffer.concat([buf, c]);
        return buf;
      },
    };
  }

  s.reply = (text, opts = {}) =>
    sock.sendMessage(s.chat, { text: String(text), contextInfo: ctx(opts) }, { quoted: m });

  s.replyImg = (url, caption) =>
    sock.sendMessage(s.chat, { image: typeof url === 'string' ? { url } : url, caption, contextInfo: ctx({}) }, { quoted: m });

  s.react = (emoji) => sock.sendMessage(s.chat, { react: { text: emoji, key: m.key } });

  return s;
}

/* ---------- Start bot ---------- */
async function start() {
  restoreSession();
  loadPlugins();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: ['TAHA MD', 'Chrome', '120.0.0'],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    markOnlineOnConnect: true,
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    getMessage: async () => ({ conversation: config.BOT_NAME }),
  });

  // Pairing code (agar SESSION_ID na ho)
  if (!sock.authState.creds.registered) {
    const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const num = await new Promise(r =>
      readline.question('\n📱 Bot number (country code ke sath, e.g. 923291489055): ', r)
    );
    readline.close();
    await new Promise(r => setTimeout(r, 3000));
    const code = await sock.requestPairingCode(num.replace(/\D/g, ''));
    console.log(`\n🔗 PAIRING CODE: ${code?.match(/.{1,4}/g)?.join('-')}\n`);
    console.log('WhatsApp > Linked Devices > Link with phone number\n');
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (up) => {
    const { connection, lastDisconnect } = up;
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('❌ Logged out. Session delete karke dobara pair karein.');
        return;
      }
      console.log('🔄 Reconnecting...');
      setTimeout(start, 5000);
    }
    if (connection === 'open') {
      console.log(`\n✅ ${config.BOT_NAME} CONNECTED\n`);
      try { await sock.newsletterFollow(config.NEWSLETTER_JID); } catch {}
      const owner = config.OWNER_NUMBER + '@s.whatsapp.net';
      await sock.sendMessage(owner, {
        image: { url: config.BOT_IMAGE },
        caption:
`╭━━━〔 *${config.BOT_NAME}* 〕━━━┈⊷
┃ ✅ Bot Connected
┃ 👑 Owner : ${config.OWNER_NAME}
┃ 🔣 Prefix : ${config.PREFIX}
┃ ⚙️ Mode : ${db.get('mode')}
┃ 📦 Commands : ${commands.length}
╰━━━━━━━━━━━━━━━┈⊷`,
        contextInfo: ctx({}),
      });
    }
  });

  /* ---------- Messages ---------- */
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const raw of messages) {
      try {
        const m = serialize(sock, raw);
        if (!m || !m.chat || m.chat === 'status@broadcast') continue;
        if (config.AUTO_READ) await sock.readMessages([m.key]).catch(() => {});

        const prefix = config.PREFIX;
        const isCmd = m.body.startsWith(prefix);
        const cmdName = isCmd ? m.body.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase() : '';
        const args = m.body.trim().split(/\s+/).slice(1);
        const text = args.join(' ');

        // group metadata + admin check
        let groupAdmins = [], isAdmin = false, isBotAdmin = false, metadata = null;
        if (m.isGroup) {
          metadata = await sock.groupMetadata(m.chat).catch(() => null);
          groupAdmins = (metadata?.participants || []).filter(p => p.admin).map(p => jidNormalizedUser(p.id));
          isAdmin = groupAdmins.includes(m.sender);
          isBotAdmin = groupAdmins.includes(jidNormalizedUser(sock.user.id));
        }

        // ---- ANTILINK ----
        if (m.isGroup && db.getGroup(m.chat, 'antilink') && !isAdmin && !m.isOwner) {
          if (/(chat\.whatsapp\.com\/|https?:\/\/)/i.test(m.body)) {
            await sock.sendMessage(m.chat, { delete: m.key }).catch(() => {});
            await m.reply(`⚠️ *ANTILINK*\n@${m.sender.split('@')[0]} link allowed nahi hai!`,
              { mentionedJid: [m.sender] });
            if (isBotAdmin) await sock.groupParticipantsUpdate(m.chat, [m.sender], 'remove').catch(() => {});
            continue;
          }
        }

        // ---- MODE (private = sirf owner) ----
        if (db.get('mode') === 'private' && !m.isOwner) continue;

        // ---- COMMAND EXECUTE ----
        if (isCmd) {
          const cmd = commands.find(c =>
            c.name === cmdName || (c.alias || []).includes(cmdName)
          );
          if (cmd) {
            if (cmd.owner && !m.isOwner) { await m.reply('🚫 Sirf owner ke liye.'); continue; }
            if (cmd.group && !m.isGroup) { await m.reply('🚫 Ye command group mein chalti hai.'); continue; }
            if (cmd.admin && !isAdmin) { await m.reply('🚫 Sirf group admin.'); continue; }
            await m.react('⏳').catch(() => {});
            try {
              await cmd.run({ sock, m, args, text, config, db, commands, metadata, isAdmin, isBotAdmin, groupAdmins });
              await m.react('✅').catch(() => {});
            } catch (e) {
              await m.react('❌').catch(() => {});
              await m.reply(`❌ Error: ${e.message}`);
            }
          }
          continue;
        }

        // ---- AI AUTO CHAT (on/off) ----
        if (db.get('ai') && !m.fromMe && m.body.length > 1) {
          const isReplyToBot = m.quoted?.key?.fromMe;
          if (!m.isGroup || isReplyToBot) {
            const ans = await require('./plugins/ai').ask(m.body);
            if (ans) await m.reply(ans);
          }
        }
      } catch (e) {
        console.log('handler error:', e.message);
      }
    }
  });

  /* ---------- WELCOME / GOODBYE ---------- */
  sock.ev.on('group-participants.update', async (up) => {
    try {
      const meta = await sock.groupMetadata(up.id).catch(() => null);
      let pp = config.BOT_IMAGE;
      for (const user of up.participants) {
        try { pp = await sock.profilePictureUrl(user, 'image'); } catch {}
        const tag = '@' + user.split('@')[0];

        if (up.action === 'add' && db.getGroup(up.id, 'welcome')) {
          await sock.sendMessage(up.id, {
            image: { url: pp },
            caption:
`╭━━〔 *WELCOME* 〕━━┈⊷
┃ 👋 ${tag}
┃ 🏠 ${meta?.subject || ''}
┃ 👥 Member #${meta?.participants?.length || '?'}
╰━━━━━━━━━━━━━┈⊷
Group rules zaroor parhein!

— *${config.BOT_NAME}*`,
            contextInfo: ctx({ mentionedJid: [user] }),
          });
        }

        if (['remove', 'leave'].includes(up.action) && db.getGroup(up.id, 'goodbye')) {
          await sock.sendMessage(up.id, {
            image: { url: pp },
            caption:
`╭━━〔 *GOODBYE* 〕━━┈⊷
┃ 🥲 ${tag} chala gaya
┃ 👥 Baqi: ${meta?.participants?.length || '?'}
╰━━━━━━━━━━━━━┈⊷

— *${config.BOT_NAME}*`,
            contextInfo: ctx({ mentionedJid: [user] }),
          });
        }
      }
    } catch {}
  });

  return sock;
}

// keep-alive web server (panel/Render ke liye zaroori)
const app = express();
app.get('/', (_, res) =>
  res.send(`<h1 style="font-family:sans-serif;text-align:center;margin-top:20vh">
  ✅ ${config.BOT_NAME} is Running<br><small>Uptime: ${runtime(process.uptime())}</small></h1>`)
);
app.listen(process.env.PORT || 3000, () => console.log('🌐 Server on'));

process.on('uncaughtException', e => console.log('uncaught:', e.message));
process.on('unhandledRejection', e => console.log('unhandled:', e?.message));

start();
