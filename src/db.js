const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bot.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  phone TEXT,
  lang TEXT DEFAULT 'uz',
  balance INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS packages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uc_amount INTEGER NOT NULL,
  price INTEGER NOT NULL,
  is_active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  uc_amount INTEGER NOT NULL,
  price INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS topups(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
`);

const seed = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
seed.run('card_number', '0000 0000 0000 0000');
seed.run('card_owner', 'Ism Familiya');
if (db.prepare('SELECT COUNT(*) c FROM packages').get().c === 0) {
  const ins = db.prepare('INSERT INTO packages(uc_amount,price) VALUES(?,?)');
  [[60, 15000], [325, 70000], [660, 140000], [1800, 370000], [3850, 780000], [8100, 1600000]]
    .forEach(([u, p]) => ins.run(u, p));
}

const getSetting = (k) => (db.prepare('SELECT value FROM settings WHERE key=?').get(k) || {}).value;
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

// Foydalanuvchi: Telegram ID bo'yicha avtomatik ro'yxatdan o'tish / kirish
function upsertUser(from) {
  const username = from.username || null;
  const first = (from.first_name || '').slice(0, 64);
  const row = db.prepare('SELECT * FROM users WHERE tg_id=?').get(from.id);
  if (!row) {
    db.prepare('INSERT INTO users(tg_id,username,first_name) VALUES(?,?,?)').run(from.id, username, first);
  } else if (row.username !== username || row.first_name !== first) {
    db.prepare('UPDATE users SET username=?, first_name=? WHERE tg_id=?').run(username, first, from.id);
  }
  return db.prepare('SELECT * FROM users WHERE tg_id=?').get(from.id);
}
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const getUserByTg = (tg) => db.prepare('SELECT * FROM users WHERE tg_id=?').get(tg);
const setLang = (tg, lang) => db.prepare('UPDATE users SET lang=? WHERE tg_id=?').run(lang, tg);
const setPhone = (tg, phone) => db.prepare('UPDATE users SET phone=? WHERE tg_id=?').run(phone, tg);

const activePackages = () => db.prepare('SELECT * FROM packages WHERE is_active=1 ORDER BY uc_amount').all();
const allPackages = () => db.prepare('SELECT * FROM packages ORDER BY uc_amount').all();
const getPackage = (id) => db.prepare('SELECT * FROM packages WHERE id=?').get(id);

// Buyurtma: balansdan darhol yechiladi
const createOrder = db.transaction((userId, pkgId, playerId) => {
  const pkg = db.prepare('SELECT * FROM packages WHERE id=? AND is_active=1').get(pkgId);
  if (!pkg) return { error: 'nopkg' };
  const u = getUser(userId);
  if (!u || u.balance < pkg.price) return { error: 'balance', need: pkg.price, have: u ? u.balance : 0 };
  db.prepare('UPDATE users SET balance=balance-? WHERE id=?').run(pkg.price, userId);
  const r = db.prepare('INSERT INTO orders(user_id,uc_amount,price,player_id) VALUES(?,?,?,?)')
    .run(userId, pkg.uc_amount, pkg.price, playerId);
  return { id: Number(r.lastInsertRowid), pkg };
});

// delivered | rejected (rad etilsa pul qaytadi). Faqat pending holatidan.
const setOrderStatus = db.transaction((id, status) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o || o.status !== 'pending') return null;
  if (status === 'rejected') db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(o.price, o.user_id);
  db.prepare("UPDATE orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, id);
  return o;
});

const createTopup = (userId, amount, fileId) =>
  Number(db.prepare('INSERT INTO topups(user_id,amount,file_id) VALUES(?,?,?)').run(userId, amount, fileId).lastInsertRowid);

const setTopupStatus = db.transaction((id, status) => {
  const t = db.prepare('SELECT * FROM topups WHERE id=?').get(id);
  if (!t || t.status !== 'pending') return null;
  if (status === 'approved') db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(t.amount, t.user_id);
  db.prepare('UPDATE topups SET status=? WHERE id=?').run(status, id);
  return t;
});

const leaderboard = (n = 10) => db.prepare(`
  SELECT u.id, u.first_name, u.username, SUM(o.uc_amount) total
  FROM orders o JOIN users u ON u.id=o.user_id
  WHERE o.status='delivered' GROUP BY u.id ORDER BY total DESC LIMIT ?`).all(n);

const adjustBalance = (userId, delta) => {
  db.prepare('UPDATE users SET balance=MAX(0,balance+?) WHERE id=?').run(delta, userId);
  return getUser(userId);
};

module.exports = {
  db, getSetting, setSetting, upsertUser, getUser, getUserByTg, setLang, setPhone,
  activePackages, allPackages, getPackage, createOrder, setOrderStatus,
  createTopup, setTopupStatus, leaderboard, adjustBalance,
};
