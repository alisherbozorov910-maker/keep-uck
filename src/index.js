require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const D = require('./db');
const { t, whichLabel } = require('./i18n');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN || TOKEN.includes('BotFather')) { console.error('BOT_TOKEN .env da yozilmagan!'); process.exit(1); }
const ADMINS = new Set((process.env.ADMIN_IDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean));
if (!ADMINS.size) console.warn('DIQQAT: ADMIN_IDS bo\'sh — admin panel ishlamaydi.');
const isAdmin = (id) => ADMINS.has(id);

const bot = new Telegraf(TOKEN);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US').replace(/,/g, ' ');
const H = { parse_mode: 'HTML' };
const state = new Map(); // tg_id -> {step, ...}
const dispName = (u) => esc(u.first_name || u.username || u.tg_id) + (u.username ? ` (@${esc(u.username)})` : '');

// ---------- Himoya: faqat shaxsiy chat, flood nazorati, ban ----------
const hits = new Map();
setInterval(() => hits.clear(), 10000).unref();
bot.use(async (ctx, next) => {
  if (!ctx.from || !ctx.chat || ctx.chat.type !== 'private') return;
  const n = (hits.get(ctx.from.id) || 0) + 1;
  hits.set(ctx.from.id, n);
  if (n > 20) { if (n === 21) await ctx.reply('⏳').catch(() => {}); return; }
  ctx.u = D.upsertUser(ctx.from);
  ctx.lang = ctx.u.lang || 'uz';
  ctx.t = (k, ...a) => t(ctx.lang, k, ...a);
  ctx.admin = isAdmin(ctx.from.id);
  if (ctx.u.banned && !ctx.admin) return ctx.reply(ctx.t('banned')).catch(() => {});
  return next();
});

const mainMenu = (ctx) => {
  const rows = [[ctx.t('m_shop'), ctx.t('m_acc')], [ctx.t('m_top'), ctx.t('m_orders')], [ctx.t('m_help'), ctx.t('m_lang')]];
  if (ctx.admin) rows.push([ctx.t('m_admin')]);
  return Markup.keyboard(rows).resize();
};
const showMenu = (ctx, text) => ctx.reply(text || ctx.t('menu'), mainMenu(ctx));
const langKb = Markup.inlineKeyboard([[Markup.button.callback('🇺🇿 O\'zbekcha', 'lang:uz'), Markup.button.callback('🇷🇺 Русский', 'lang:ru')]]);

// ---------- Ro'yxatdan o'tish (Telegram profil + telefon) ----------
const askPhone = (ctx) => ctx.reply(ctx.t('share_phone'),
  Markup.keyboard([[Markup.button.contactRequest(ctx.t('btn_phone'))]]).resize().oneTime());

bot.start(async (ctx) => {
  state.delete(ctx.from.id);
  if (!ctx.u.phone) return ctx.reply(t('uz', 'choose_lang'), langKb);
  return showMenu(ctx, ctx.t('welcome', esc(ctx.u.first_name || '')));
});

bot.action(/^lang:(uz|ru)$/, async (ctx) => {
  D.setLang(ctx.from.id, ctx.match[1]);
  ctx.lang = ctx.match[1]; ctx.t = (k, ...a) => t(ctx.lang, k, ...a);
  await ctx.answerCbQuery(ctx.t('lang_set')).catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  const u = D.getUserByTg(ctx.from.id);
  if (!u.phone) return askPhone(ctx);
  return showMenu(ctx);
});

bot.on('contact', async (ctx) => {
  const c = ctx.message.contact;
  if (c.user_id !== ctx.from.id) return ctx.reply(ctx.t('phone_wrong'));
  D.setPhone(ctx.from.id, c.phone_number);
  return showMenu(ctx, ctx.t('welcome', esc(ctx.u.first_name || '')));
});

// Raqam yuborilmaguncha boshqa funksiyalar yopiq
bot.use((ctx, next) => {
  if (!ctx.u.phone && !ctx.admin) return askPhone(ctx);
  return next();
});

// ---------- Foydalanuvchi bo'limlari ----------
const sections = {
  async m_shop(ctx) {
    const pk = D.activePackages();
    if (!pk.length) return ctx.reply(ctx.t('no_pkg'));
    const kb = pk.map((p) => [Markup.button.callback(`💎 ${p.uc_amount} UC — ${fmt(p.price)}`, `buy:${p.id}`)]);
    return ctx.reply(ctx.t('pick_pkg'), Markup.inlineKeyboard(kb));
  },
  async m_acc(ctx) {
    const u = D.getUserByTg(ctx.from.id);
    return ctx.reply(ctx.t('acc', fmt(u.balance), esc(u.phone), esc(D.getSetting('card_number')), esc(D.getSetting('card_owner'))), {
      ...H, ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('btn_topup'), 'topup')], [Markup.button.callback(ctx.t('btn_hist'), 'thist')]]),
    });
  },
  async m_top(ctx) {
    const rows = D.leaderboard(10);
    if (!rows.length) return ctx.reply(ctx.t('top_empty'));
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => `${medals[i] || (i + 1) + '.'} ${esc(r.first_name || r.username || 'User')} — <b>${fmt(r.total)} UC</b>`);
    return ctx.reply(ctx.t('top_title') + '\n' + lines.join('\n'), H);
  },
  async m_orders(ctx) {
    const rows = D.db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 10').all(ctx.u.id);
    if (!rows.length) return ctx.reply(ctx.t('none'));
    const st = t(ctx.lang, 'st');
    return ctx.reply(`📋 <b>${ctx.t('my_orders')}</b>\n\n` + rows.map((o) => `#${o.id} · ${o.uc_amount} UC · ${fmt(o.price)} · ${st[o.status]}`).join('\n'), H);
  },
  async m_help(ctx) { state.set(ctx.from.id, { step: 'support' }); return ctx.reply(ctx.t('help'), H); },
  async m_lang(ctx) { return ctx.reply(ctx.t('choose_lang'), langKb); },
  async m_admin(ctx) { return ctx.admin ? adminHome(ctx) : null; },
};

// Menyu tugmasi bosilsa — holat tozalanadi va bo'lim ochiladi
bot.on('text', async (ctx, next) => {
  const key = whichLabel(ctx.message.text);
  if (key) { state.delete(ctx.from.id); return sections[key](ctx); }
  return next();
});

// ---------- Sotib olish ----------
bot.action(/^buy:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const p = D.getPackage(Number(ctx.match[1]));
  if (!p || !p.is_active) return;
  state.set(ctx.from.id, { step: 'pid', pkg: p.id });
  return ctx.reply(ctx.t('ask_pid', p.uc_amount, fmt(p.price)), H);
});
bot.action('ok', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const s = state.get(ctx.from.id);
  await ctx.editMessageReplyMarkup().catch(() => {});
  if (!s || s.step !== 'confirm') return;
  state.delete(ctx.from.id);
  const r = D.createOrder(ctx.u.id, s.pkg, s.pid);
  if (r.error === 'balance') return ctx.reply(ctx.t('low_bal', fmt(r.need), fmt(r.have)));
  if (r.error) return ctx.reply(ctx.t('no_pkg'));
  await ctx.reply(ctx.t('ordered', r.id));
  const kb = Markup.inlineKeyboard([[Markup.button.callback('✅ Yuborildi', `od:${r.id}`), Markup.button.callback('❌ Rad', `or:${r.id}`)]]);
  notifyAdmins(`🛒 <b>Yangi buyurtma #${r.id}</b>\n👤 ${dispName(ctx.u)}\n📱 ${esc(ctx.u.phone)}\n💎 ${r.pkg.uc_amount} UC (${fmt(r.pkg.price)})\n🎮 Player ID: <code>${esc(s.pid)}</code>`, kb);
});
bot.action('no', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  state.delete(ctx.from.id);
  await ctx.editMessageReplyMarkup().catch(() => {});
  return ctx.reply(ctx.t('cancelled'));
});

// ---------- Hisobni to'ldirish ----------
bot.action('topup', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  state.set(ctx.from.id, { step: 'amount' });
  return ctx.reply(ctx.t('ask_amount'));
});
bot.action('thist', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const rows = D.db.prepare('SELECT * FROM topups WHERE user_id=? ORDER BY id DESC LIMIT 10').all(ctx.u.id);
  if (!rows.length) return ctx.reply(ctx.t('none'));
  const st = t(ctx.lang, 'st');
  return ctx.reply(rows.map((x) => `#${x.id} · ${fmt(x.amount)} · ${st[x.status]}`).join('\n'));
});

// ---------- Admin: xabar yuborish ----------
async function notifyAdmins(text, kb) {
  for (const id of ADMINS) await bot.telegram.sendMessage(id, text, { ...H, ...(kb || {}) }).catch(() => {});
}
async function sendUser(userId, text, extra) {
  const u = D.getUser(userId);
  if (u) await bot.telegram.sendMessage(u.tg_id, text, { ...H, ...(extra || {}) }).catch(() => {});
}
const userLang = (userId) => (D.getUser(userId) || {}).lang || 'uz';

bot.action(/^(od|or):(\d+)$/, async (ctx) => {
  if (!ctx.admin) return ctx.answerCbQuery('⛔').catch(() => {});
  const status = ctx.match[1] === 'od' ? 'delivered' : 'rejected';
  const o = D.setOrderStatus(Number(ctx.match[2]), status);
  await ctx.answerCbQuery(o ? 'OK' : 'Allaqachon hal qilingan').catch(() => {});
  if (!o) return;
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply(`Buyurtma #${o.id}: ${status === 'delivered' ? '✅ yuborildi' : '❌ rad etildi (pul qaytdi)'}`);
  const l = userLang(o.user_id);
  sendUser(o.user_id, status === 'delivered' ? t(l, 'o_delivered', o.id, o.uc_amount) : t(l, 'o_rejected', o.id));
});
bot.action(/^(ta|tr):(\d+)$/, async (ctx) => {
  if (!ctx.admin) return ctx.answerCbQuery('⛔').catch(() => {});
  const ok = ctx.match[1] === 'ta';
  const x = D.setTopupStatus(Number(ctx.match[2]), ok ? 'approved' : 'rejected');
  await ctx.answerCbQuery(x ? 'OK' : 'Allaqachon hal qilingan').catch(() => {});
  if (!x) return;
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply(`To'ldirish #${x.id}: ${ok ? '✅ tasdiqlandi' : '❌ rad etildi'}`);
  const l = userLang(x.user_id);
  sendUser(x.user_id, t(l, ok ? 't_ok' : 't_no', fmt(x.amount)));
});
bot.action(/^rp:(\d+)$/, async (ctx) => {
  if (!ctx.admin) return ctx.answerCbQuery('⛔').catch(() => {});
  await ctx.answerCbQuery().catch(() => {});
  state.set(ctx.from.id, { step: 'a_reply', uid: Number(ctx.match[1]) });
  return ctx.reply('✍️ Javob matnini yozing:');
});

// ---------- Admin panel ----------
const adminHome = (ctx) => ctx.reply('🛠 <b>Admin panel</b>', {
  ...H, ...Markup.inlineKeyboard([
    [Markup.button.callback('⏳ Buyurtmalar (jarayonda)', 'a:orders'), Markup.button.callback('✅ Yuborilganlar', 'a:done')],
    [Markup.button.callback('💳 To\'ldirishlar', 'a:topups'), Markup.button.callback('📦 UC paketlari', 'a:pkgs')],
    [Markup.button.callback('👥 Foydalanuvchi qidirish', 'a:user'), Markup.button.callback('📊 Statistika', 'a:stats')],
    [Markup.button.callback('💳 Karta sozlamasi', 'a:card'), Markup.button.callback('📢 E\'lon yuborish', 'a:bcast')],
  ]),
});
const guard = (fn) => async (ctx) => { if (!ctx.admin) return ctx.answerCbQuery('⛔').catch(() => {}); await ctx.answerCbQuery().catch(() => {}); return fn(ctx); };

bot.command('admin', (ctx) => (ctx.admin ? adminHome(ctx) : null));

bot.action('a:orders', guard(async (ctx) => {
  const rows = D.db.prepare("SELECT o.*, u.first_name, u.username, u.phone FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status='pending' ORDER BY o.id LIMIT 20").all();
  if (!rows.length) return ctx.reply('Jarayondagi buyurtma yo\'q.');
  for (const o of rows) {
    await ctx.reply(`🛒 <b>#${o.id}</b> ${dispName(o)}\n📱 ${esc(o.phone)}\n💎 ${o.uc_amount} UC (${fmt(o.price)})\n🎮 <code>${esc(o.player_id)}</code>`, {
      ...H, ...Markup.inlineKeyboard([[Markup.button.callback('✅ Yuborildi', `od:${o.id}`), Markup.button.callback('❌ Rad', `or:${o.id}`)]]),
    });
  }
}));
bot.action('a:done', guard(async (ctx) => {
  const rows = D.db.prepare("SELECT o.*, u.first_name, u.username FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status='delivered' ORDER BY o.id DESC LIMIT 20").all();
  if (!rows.length) return ctx.reply('Hali yuborilgan buyurtma yo\'q.');
  return ctx.reply('✅ <b>Oxirgi yuborilganlar</b>\n\n' + rows.map((o) => `#${o.id} · ${dispName(o)} · ${o.uc_amount} UC · <code>${esc(o.player_id)}</code>`).join('\n'), H);
}));
bot.action('a:topups', guard(async (ctx) => {
  const rows = D.db.prepare("SELECT x.*, u.first_name, u.username FROM topups x JOIN users u ON u.id=x.user_id WHERE x.status='pending' ORDER BY x.id LIMIT 20").all();
  if (!rows.length) return ctx.reply('Kutilayotgan to\'ldirish yo\'q.');
  for (const x of rows) {
    await ctx.replyWithPhoto(x.file_id, {
      caption: `💳 To'ldirish #${x.id}\n${x.first_name || ''} ${x.username ? '@' + x.username : ''}\nSumma: ${fmt(x.amount)} so'm`,
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Tasdiqlash', `ta:${x.id}`), Markup.button.callback('❌ Rad', `tr:${x.id}`)]]),
    }).catch(() => {});
  }
}));
bot.action('a:stats', guard(async (ctx) => {
  const g = (q) => D.db.prepare(q).get().c || 0;
  return ctx.reply(`📊 <b>Statistika</b>\n\n👥 Foydalanuvchilar: ${g('SELECT COUNT(*) c FROM users')}\n⏳ Jarayondagi buyurtmalar: ${g("SELECT COUNT(*) c FROM orders WHERE status='pending'")}\n✅ Yuborilgan: ${g("SELECT COUNT(*) c FROM orders WHERE status='delivered'")}\n💎 Jami UC: ${fmt(g("SELECT SUM(uc_amount) c FROM orders WHERE status='delivered'"))}\n💵 Tushum: ${fmt(g("SELECT SUM(price) c FROM orders WHERE status='delivered'"))} so'm`, H);
}));

// UC paketlari
const pkgsView = async (ctx) => {
  const pk = D.allPackages();
  const kb = pk.map((p) => [Markup.button.callback(`${p.is_active ? '🟢' : '🔴'} ${p.uc_amount} UC — ${fmt(p.price)}`, `pk:${p.id}`)]);
  kb.push([Markup.button.callback('➕ Yangi paket', 'pkadd')]);
  return ctx.reply('📦 <b>UC paketlari</b> (bosib o\'zgartiring)', { ...H, ...Markup.inlineKeyboard(kb) });
};
bot.action('a:pkgs', guard(pkgsView));
bot.action(/^pk:(\d+)$/, guard(async (ctx) => {
  const p = D.getPackage(Number(ctx.match[1]));
  if (!p) return;
  return ctx.reply(`💎 ${p.uc_amount} UC — ${fmt(p.price)} so'm (${p.is_active ? 'faol' : 'o\'chirilgan'})`, Markup.inlineKeyboard([
    [Markup.button.callback('💵 Narxni o\'zgartirish', `pkp:${p.id}`)],
    [Markup.button.callback(p.is_active ? '🔴 O\'chirish' : '🟢 Yoqish', `pkt:${p.id}`)],
  ]));
}));
bot.action(/^pkp:(\d+)$/, guard(async (ctx) => { state.set(ctx.from.id, { step: 'a_price', id: Number(ctx.match[1]) }); return ctx.reply('Yangi narxni yozing (so\'m, faqat raqam):'); }));
bot.action(/^pkt:(\d+)$/, guard(async (ctx) => {
  D.db.prepare('UPDATE packages SET is_active=1-is_active WHERE id=?').run(Number(ctx.match[1]));
  return pkgsView(ctx);
}));
bot.action('pkadd', guard(async (ctx) => { state.set(ctx.from.id, { step: 'a_add' }); return ctx.reply('Yangi paket: "UC miqdori narx" ko\'rinishida yozing.\nMasalan: 120 30000'); }));

bot.action('a:user', guard(async (ctx) => { state.set(ctx.from.id, { step: 'a_user' }); return ctx.reply('Foydalanuvchining Telegram ID, @username yoki telefon raqamini yozing:'); }));
bot.action(/^ub:(\d+)$/, guard(async (ctx) => { state.set(ctx.from.id, { step: 'a_bal', uid: Number(ctx.match[1]) }); return ctx.reply('Balansga qo\'shiladigan summani yozing (ayirish uchun minus: -5000):'); }));
bot.action(/^ux:(\d+)$/, guard(async (ctx) => {
  const u = D.getUser(Number(ctx.match[1]));
  if (!u || isAdmin(u.tg_id)) return;
  D.db.prepare('UPDATE users SET banned=1-banned WHERE id=?').run(u.id);
  return ctx.reply(u.banned ? '✅ Blokdan chiqarildi' : '⛔ Bloklandi');
}));
bot.action('a:card', guard(async (ctx) => {
  return ctx.reply(`💳 Hozirgi karta: <code>${esc(D.getSetting('card_number'))}</code>\n👤 ${esc(D.getSetting('card_owner'))}`, {
    ...H, ...Markup.inlineKeyboard([[Markup.button.callback('Karta raqami', 'cn'), Markup.button.callback('Karta egasi', 'co')]]),
  });
}));
bot.action('cn', guard(async (ctx) => { state.set(ctx.from.id, { step: 'a_cn' }); return ctx.reply('Yangi karta raqamini yozing:'); }));
bot.action('co', guard(async (ctx) => { state.set(ctx.from.id, { step: 'a_co' }); return ctx.reply('Karta egasining ismini yozing:'); }));
bot.action('a:bcast', guard(async (ctx) => { state.set(ctx.from.id, { step: 'a_bcast' }); return ctx.reply('Hammaga yuboriladigan e\'lon matnini yozing:'); }));

// ---------- Matn / rasm kiritish (holatlar) ----------
bot.on('photo', async (ctx) => {
  const s = state.get(ctx.from.id);
  if (!s || s.step !== 'receipt') return;
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  state.delete(ctx.from.id);
  const id = D.createTopup(ctx.u.id, s.amount, fileId);
  await ctx.reply(ctx.t('topup_sent'));
  for (const a of ADMINS) {
    await bot.telegram.sendPhoto(a, fileId, {
      caption: `💳 To'ldirish #${id}\n${ctx.u.first_name || ''} ${ctx.u.username ? '@' + ctx.u.username : ''}\n📱 ${ctx.u.phone}\nSumma: ${fmt(s.amount)} so'm`,
      ...Markup.inlineKeyboard([[Markup.button.callback('✅ Tasdiqlash', `ta:${id}`), Markup.button.callback('❌ Rad', `tr:${id}`)]]),
    }).catch(() => {});
  }
});

const num = (s) => { const x = String(s).replace(/[\s,]/g, ''); return /^-?\d{1,12}$/.test(x) ? Number(x) : NaN; };

bot.on('text', async (ctx) => {
  const s = state.get(ctx.from.id);
  const text = ctx.message.text.trim();
  if (!s) return ctx.reply(ctx.t('use_buttons'), mainMenu(ctx));
  if (text.startsWith('/')) return;

  // --- foydalanuvchi holatlari ---
  if (s.step === 'pid') {
    if (!/^\d{5,15}$/.test(text)) return ctx.reply(ctx.t('bad_pid'));
    const p = D.getPackage(s.pkg);
    if (!p || !p.is_active) { state.delete(ctx.from.id); return ctx.reply(ctx.t('no_pkg')); }
    state.set(ctx.from.id, { step: 'confirm', pkg: s.pkg, pid: text });
    return ctx.reply(ctx.t('confirm', p.uc_amount, fmt(p.price), text), {
      ...H, ...Markup.inlineKeyboard([[Markup.button.callback(ctx.t('btn_yes'), 'ok'), Markup.button.callback(ctx.t('btn_no'), 'no')]]),
    });
  }
  if (s.step === 'amount') {
    const a = num(text);
    if (!(a >= 1000 && a <= 50000000)) return ctx.reply(ctx.t('bad_amount'));
    state.set(ctx.from.id, { step: 'receipt', amount: a });
    return ctx.reply(ctx.t('ask_receipt'), H);
  }
  if (s.step === 'receipt') return ctx.reply(ctx.t('need_photo'));
  if (s.step === 'support') {
    D.db.prepare('INSERT INTO messages(user_id,sender,text) VALUES(?,?,?)').run(ctx.u.id, 'user', text.slice(0, 2000));
    await ctx.reply(ctx.t('help_sent'));
    return notifyAdmins(`🆘 <b>Yordam</b> — ${dispName(ctx.u)}\n📱 ${esc(ctx.u.phone)}\n\n${esc(text.slice(0, 2000))}`,
      Markup.inlineKeyboard([[Markup.button.callback('✍️ Javob berish', `rp:${ctx.u.id}`)]]));
  }

  // --- admin holatlari ---
  if (!ctx.admin) return;
  if (s.step === 'a_reply') {
    state.delete(ctx.from.id);
    D.db.prepare('INSERT INTO messages(user_id,sender,text) VALUES(?,?,?)').run(s.uid, 'admin', text.slice(0, 2000));
    await sendUser(s.uid, t(userLang(s.uid), 'admin_reply', esc(text.slice(0, 2000))));
    return ctx.reply('✅ Javob yuborildi.');
  }
  if (s.step === 'a_price') {
    const v = num(text);
    if (!(v > 0)) return ctx.reply('❌ Faqat musbat raqam.');
    D.db.prepare('UPDATE packages SET price=? WHERE id=?').run(v, s.id);
    state.delete(ctx.from.id);
    return pkgsView(ctx);
  }
  if (s.step === 'a_add') {
    const m = text.match(/^(\d{1,6})\s+([\d\s]{3,12})$/);
    if (!m) return ctx.reply('❌ Format: 120 30000');
    D.db.prepare('INSERT INTO packages(uc_amount,price) VALUES(?,?)').run(Number(m[1]), num(m[2]));
    state.delete(ctx.from.id);
    return pkgsView(ctx);
  }
  if (s.step === 'a_cn') { D.setSetting('card_number', text.slice(0, 40)); state.delete(ctx.from.id); return ctx.reply('✅ Saqlandi.'); }
  if (s.step === 'a_co') { D.setSetting('card_owner', text.slice(0, 60)); state.delete(ctx.from.id); return ctx.reply('✅ Saqlandi.'); }
  if (s.step === 'a_user') {
    state.delete(ctx.from.id);
    const q = text.replace(/^@/, '');
    const digits = q.replace(/\D/g, '');
    const u = D.db.prepare("SELECT * FROM users WHERE tg_id=? OR username=? COLLATE NOCASE OR (?>=5 AND phone LIKE ?)").get(num(q) || -1, q, digits.length, '%' + digits);
    if (!u) return ctx.reply('Topilmadi.');
    return ctx.reply(`👤 ${dispName(u)}\nTG ID: <code>${u.tg_id}</code>\n📱 ${esc(u.phone)}\n💰 ${fmt(u.balance)} so'm\n${u.banned ? '⛔ bloklangan' : ''}`, {
      ...H, ...Markup.inlineKeyboard([[Markup.button.callback('💰 Balans o\'zgartirish', `ub:${u.id}`)], [Markup.button.callback('⛔ Blok / blokdan chiqarish', `ux:${u.id}`)]]),
    });
  }
  if (s.step === 'a_bal') {
    const v = num(text);
    if (!Number.isFinite(v) || v === 0) return ctx.reply('❌ Raqam yozing, masalan 5000 yoki -5000');
    state.delete(ctx.from.id);
    const u = D.adjustBalance(s.uid, v);
    return ctx.reply(`✅ Yangi balans: ${fmt(u.balance)} so'm`);
  }
  if (s.step === 'a_bcast') {
    state.delete(ctx.from.id);
    const users = D.db.prepare('SELECT tg_id FROM users WHERE banned=0').all();
    let ok = 0;
    for (const u of users) {
      try { await bot.telegram.sendMessage(u.tg_id, '📢 ' + text.slice(0, 3500)); ok++; } catch (e) { /* bloklagan */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    return ctx.reply(`✅ ${ok}/${users.length} ta foydalanuvchiga yuborildi.`);
  }
});

bot.catch((err, ctx) => console.error('Xato:', ctx && ctx.updateType, err && err.message));
bot.launch().then(() => console.log('Bot ishga tushdi')).catch((e) => { console.error(e.message); process.exit(1); });
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
