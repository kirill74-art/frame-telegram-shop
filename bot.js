const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MINI_APP_URL =
  process.env.MINI_APP_URL || "https://frame-shop-i7u4.onrender.com";

if (!BOT_TOKEN) {
  throw new Error("Не задан BOT_TOKEN в Render Environment");
}

if (!DATABASE_URL) {
  throw new Error("Не задан DATABASE_URL в Render Environment");
}

const bot = new Telegraf(BOT_TOKEN);

const STAR_PACKS = {
  small: {
    stars: 10,
    crystals: 10,
    title: "10 кристаллов"
  },
  medium: {
    stars: 45,
    crystals: 50,
    title: "50 кристаллов"
  },
  large: {
    stars: 80,
    crystals: 100,
    title: "100 кристаллов"
  }
};

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ---------------- DATABASE ----------------

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      balance INTEGER NOT NULL DEFAULT 0,
      free_prompt_used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id SERIAL PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      full_prompt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS unlocks (
      user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
      prompt_id INTEGER REFERENCES prompts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, prompt_id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id BIGINT REFERENCES users(telegram_id) ON DELETE CASCADE,
      prompt_id INTEGER REFERENCES prompts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, prompt_id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(telegram_id),
      telegram_payment_charge_id TEXT UNIQUE,
      invoice_payload TEXT UNIQUE,
      amount INTEGER NOT NULL,
      crystals INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS crystals INTEGER NOT NULL DEFAULT 0;
  `);

  console.log("PostgreSQL подключён, таблицы готовы");
}

// ---------------- TELEGRAM AUTH ----------------

function verifyTelegram(initData) {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) return null;

  params.delete("hash");

  const entries = [...params.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  const dataCheckString = entries
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  const a = Buffer.from(calculatedHash, "hex");
  const b = Buffer.from(hash, "hex");

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));

  if (!authDate || Date.now() / 1000 - authDate > 86400) {
    return null;
  }

  try {
    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

async function telegramAuth(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];
  const user = verifyTelegram(initData);

  if (!user || !user.id) {
    return res.status(401).json({
      error: "Не удалось подтвердить Telegram"
    });
  }

  try {
    await pool.query(
      `INSERT INTO users (telegram_id, username)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id)
       DO UPDATE SET username = EXCLUDED.username`,
      [user.id, user.username || null]
    );

    req.telegramUser = user;
    next();
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Ошибка базы данных"
    });
  }
}

// ---------------- HEALTH ----------------

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "FRAME"
  });
});

// ---------------- PROFILE ----------------

app.get("/api/me", telegramAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT telegram_id, username, balance,
              free_prompt_used, created_at
       FROM users
       WHERE telegram_id = $1`,
      [req.telegramUser.id]
    );

    res.json({
      user: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка профиля" });
  }
});

// ---------------- CATEGORIES ----------------

app.get("/api/categories", telegramAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT category, COUNT(*)::int AS count
       FROM prompts
       GROUP BY category
       ORDER BY category`
    );

    res.json({
      categories: result.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка категорий" });
  }
});

// ---------------- PROMPTS ----------------

app.get("/api/prompts", telegramAuth, async (req, res) => {
  try {
    const category = req.query.category;
    const search = req.query.search || "";

    const result = await pool.query(
      `SELECT id, category, title
       FROM prompts
       WHERE ($1::text IS NULL OR category = $1)
         AND title ILIKE $2
       ORDER BY id`,
      [category || null, `%${search}%`]
    );

    res.json({
      prompts: result.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка каталога" });
  }
});

app.get("/api/prompts/:id", telegramAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Неверный ID" });
    }

    const result = await pool.query(
      `SELECT p.id, p.category, p.title,
         CASE
           WHEN u.prompt_id IS NOT NULL
                OR usr.free_prompt_used = FALSE
           THEN p.full_prompt
           ELSE NULL
         END AS full_prompt,
         (u.prompt_id IS NOT NULL) AS unlocked
       FROM prompts p
       CROSS JOIN users usr
       LEFT JOIN unlocks u
         ON u.prompt_id = p.id
        AND u.user_id = usr.telegram_id
       WHERE p.id = $1
         AND usr.telegram_id = $2`,
      [id, req.telegramUser.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Промпт не найден"
      });
    }

    res.json({
      prompt: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка промпта" });
  }
});

// ---------------- UNLOCK PROMPT ----------------

app.post("/api/prompts/:id/unlock", telegramAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userId = req.telegramUser.id;
    const promptId = Number(req.params.id);

    if (!Number.isInteger(promptId) || promptId < 1) {
      throw new Error("Неверный ID промпта");
    }

    const prompt = await client.query(
      "SELECT id FROM prompts WHERE id = $1",
      [promptId]
    );

    if (!prompt.rowCount) {
      throw new Error("Промпт не найден");
    }

    const already = await client.query(
      `SELECT 1 FROM unlocks
       WHERE user_id = $1 AND prompt_id = $2`,
      [userId, promptId]
    );

    if (already.rowCount) {
      await client.query("COMMIT");

      return res.json({
        success: true,
        message: "Уже открыт"
      });
    }

    const user = await client.query(
      `SELECT balance, free_prompt_used
       FROM users
       WHERE telegram_id = $1
       FOR UPDATE`,
      [userId]
    );

    if (!user.rowCount) {
      throw new Error("Пользователь не найден");
    }

    if (!user.rows[0].free_prompt_used) {
      await client.query(
        `UPDATE users
         SET free_prompt_used = TRUE
         WHERE telegram_id = $1`,
        [userId]
      );
    } else {
      if (user.rows[0].balance < 1) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          error: "Недостаточно кристаллов"
        });
      }

      await client.query(
        `UPDATE users
         SET balance = balance - 1
         WHERE telegram_id = $1`,
        [userId]
      );
    }

    await client.query(
      `INSERT INTO unlocks (user_id, prompt_id)
       VALUES ($1, $2)`,
      [userId, promptId]
    );

    const updated = await client.query(
      `SELECT balance FROM users
       WHERE telegram_id = $1`,
      [userId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      balance: updated.rows[0].balance
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    res.status(400).json({
      error: error.message
    });
  } finally {
    client.release();
  }
});

// ---------------- FAVORITES ----------------

app.get("/api/favorites", telegramAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.id, p.category, p.title
       FROM favorites f
       JOIN prompts p ON p.id = f.prompt_id
       WHERE f.user_id = $1
       ORDER BY f.created_at DESC`,
      [req.telegramUser.id]
    );

    res.json({
      favorites: result.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка избранного" });
  }
});

app.post("/api/favorites/:id", telegramAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Неверный ID" });
    }

    await pool.query(
      `INSERT INTO favorites (user_id, prompt_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.telegramUser.id, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка избранного" });
  }
});

app.delete("/api/favorites/:id", telegramAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM favorites
       WHERE user_id = $1 AND prompt_id = $2`,
      [req.telegramUser.id, Number(req.params.id)]
    );

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка избранного" });
  }
});

// ---------------- TELEGRAM STARS INVOICE ----------------

app.post("/api/stars/invoice", telegramAuth, async (req, res) => {
  const pack = STAR_PACKS[req.body?.pack];

  if (!pack) {
    return res.status(400).json({
      error: "Неизвестный пакет"
    });
  }

  const payload =
    `frame_${req.telegramUser.id}_${crypto.randomUUID()}`;

  try {
    await pool.query(
      `INSERT INTO payments
       (user_id, invoice_payload, amount, crystals, currency, status)
       VALUES ($1, $2, $3, $4, 'XTR', 'pending')`,
      [
        req.telegramUser.id,
        payload,
        pack.stars,
        pack.crystals
      ]
    );

    const invoiceUrl = await bot.telegram.createInvoiceLink(
      pack.title,
      `Пополнение баланса FRAME: ${pack.crystals} кристаллов`,
      payload,
      "",
      "XTR",
      [
        {
          label: pack.title,
          amount: pack.stars
        }
      ]
    );

    res.json({
      invoice_url: invoiceUrl
    });
  } catch (error) {
    console.error("Ошибка создания счёта:", error);

    await pool.query(
      `DELETE FROM payments
       WHERE invoice_payload = $1
         AND status = 'pending'`,
      [payload]
    ).catch(() => {});

    res.status(500).json({
      error: "Не удалось создать счёт. Попробуй ещё раз."
    });
  }
});

// ---------------- STATIC FILES ----------------

app.use(express.static(path.join(__dirname)));

// ---------------- TELEGRAM BOT ----------------

bot.start(async (ctx) => {
  await ctx.reply(
    "🌌 Добро пожаловать в FRAME!\n\nТвоя библиотека видеопромптов ждёт тебя.",
    Markup.inlineKeyboard([
      Markup.button.webApp("🚀 Открыть FRAME", MINI_APP_URL)
    ])
  );
});

// ---------------- PRE-CHECKOUT ----------------

bot.on("pre_checkout_query", async (ctx) => {
  const query = ctx.update.pre_checkout_query;

  try {
    const result = await pool.query(
      `SELECT id
       FROM payments
       WHERE invoice_payload = $1
         AND user_id = $2
         AND amount = $3
         AND currency = $4
         AND status = 'pending'`,
      [
        query.invoice_payload,
        query.from.id,
        query.total_amount,
        query.currency
      ]
    );

    if (!result.rowCount) {
      return ctx.answerPreCheckoutQuery(
        false,
        "Счёт не найден или уже использован. Создай новый."
      );
    }

    await ctx.answerPreCheckoutQuery(true);
  } catch (error) {
    console.error("Ошибка проверки платежа:", error);

    await ctx.answerPreCheckoutQuery(
      false,
      "Не удалось проверить платёж. Попробуй позже."
    );
  }
});

// ---------------- SUCCESSFUL PAYMENT ----------------

bot.on("successful_payment", async (ctx) => {
  const payment = ctx.message.successful_payment;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT *
       FROM payments
       WHERE invoice_payload = $1
       FOR UPDATE`,
      [payment.invoice_payload]
    );

    if (!result.rowCount) {
      throw new Error("Платёж не найден в базе");
    }

    const record = result.rows[0];

    // Проверяем владельца и данные платежа
    if (String(record.user_id) !== String(ctx.from.id)) {
      throw new Error("Пользователь платежа не совпадает");
    }

    if (
      payment.currency !== "XTR" ||
      payment.total_amount !== record.amount
    ) {
      throw new Error("Данные платежа не совпадают");
    }

    // Защита от повторного начисления
    if (record.status === "paid") {
      await client.query("COMMIT");
      return;
    }

    if (record.status !== "pending") {
      throw new Error("Платёж не ожидает подтверждения");
    }

    const updatedUser = await client.query(
      `UPDATE users
       SET balance = balance + $1
       WHERE telegram_id = $2
       RETURNING balance`,
      [record.crystals, record.user_id]
    );

    if (!updatedUser.rowCount) {
      throw new Error("Пользователь не найден");
    }

    await client.query(
      `UPDATE payments
       SET status = 'paid',
           telegram_payment_charge_id = $1
       WHERE id = $2`,
      [
        payment.telegram_payment_charge_id,
        record.id
      ]
    );

    await client.query("COMMIT");

    await ctx.reply(
      `💎 Оплата прошла успешно!\n\n` +
      `Начислено: ${record.crystals} кристаллов.\n` +
      `Баланс: ${updatedUser.rows[0].balance} кристаллов.\n\n` +
      `Кристаллы уже доступны в FRAME!`
    );

    console.log(
      `FRAME: пользователь ${record.user_id}, ` +
      `начислено ${record.crystals} кристаллов`
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});

    console.error("Ошибка обработки оплаты:", error);

    await ctx.reply(
      "Платёж получен, но возникла ошибка начисления. Обратись в поддержку FRAME."
    );
  } finally {
    client.release();
  }
});

// ---------------- ERROR HANDLING ----------------

bot.catch((error) => {
  console.error("Ошибка Telegram:", error);
});

// ---------------- START SERVER ----------------

async function start() {
  await initDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`FRAME запущен на порту ${PORT}`);
  });

  await bot.launch();

  console.log("Telegram-бот запущен");
}

start().catch((error) => {
  console.error("Ошибка запуска:", error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
