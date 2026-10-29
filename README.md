# PUBG UC Telegram Bot

## 1. Bot yaratish (telefonda)
1. Telegramda **@BotFather** ni oching → `/newbot` → nom va @username bering.
2. U sizga **TOKEN** beradi (uzun matn). Uni saqlab qo'ying, hech kimga bermang.
3. Telegramda **@userinfobot** ni oching → `/start` → u sizning **ID** raqamingizni beradi (admin ID).

## 2. Hosting (Render.com)
Bot doim ishlab turishi va bazasi o'chib ketmasligi kerak, shuning uchun:
- New → **Background Worker** (pullik reja kerak), repo: shu loyiha
- Build Command: `npm install`
- Start Command: `npm start`
- **Disk** qo'shing: Mount Path `/data`, 1 GB
- Environment:
  - `NODE_VERSION` = `18.20.4`
  - `BOT_TOKEN` = BotFather bergan token
  - `ADMIN_IDS` = sizning ID (bir nechta bo'lsa vergul bilan: `111,222`)
  - `DB_PATH` = `/data/bot.db`

Bepul rejada baza har deployda o'chib ketadi va bot uxlab qoladi — haqiqiy foydalanish uchun tavsiya etilmaydi.

## 3. Admin
Botda `/admin` yoki menyudagi **🛠 Admin panel** (faqat ADMIN_IDS dagilarga ko'rinadi).
