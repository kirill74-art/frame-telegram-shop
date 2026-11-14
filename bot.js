const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const MINI_APP_URL = process.env.MINI_APP_URL;
const PURCHASES_ENABLED = true;

if (!BOT_TOKEN) throw new Error("Не задан BOT_TOKEN");
if (!DATABASE_URL) throw new Error("Не задан DATABASE_URL");
if (!MINI_APP_URL) throw new Error("Не задан MINI_APP_URL");

const bot = new Telegraf(BOT_TOKEN);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable"
    ? false
    : { rejectUnauthorized: false },
  max: 10,
  connectionTimeoutMillis: 10000
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const CATEGORIES = [
  "Страшные истории",
  "Представь, если…",
  "Ночные правила",
  "Тайны и загадки"
];

const PACKS = {
  pack10: { stars: 10, crystals: 10, title: "10 кристаллов" },
  pack50: { stars: 45, crystals: 50, title: "50 кристаллов" },
  pack100: { stars: 80, crystals: 100, title: "100 кристаллов" },
  pack3: { stars: 3, crystals: 3, title: "Временный мини-пак" }
};

const PROMPTS = require("./prompts.json");

function validatePrompts() {
  if (!Array.isArray(PROMPTS) || PROMPTS.length !== 396) {
    throw new Error("prompts.json должен содержать ровно 396 промптов");
  }

  const counts = Object.fromEntries(
    CATEGORIES.map(category => [
      category,
      PROMPTS.filter(p => p.category === category).length
    ])
  );

  for (const category of CATEGORIES) {
    if (counts[category] !== 99) {
      throw new Error(`В категории ${category} должно быть 99 промптов`);
    }

    const free = PROMPTS.filter(
      p => p.category === category && p.is_free === true
    );

    if (free.length !== 1) {
      throw new Error(
        `В категории ${category} должен быть ровно один бесплатный промпт`
      );
    }
  }

  for (const p of PROMPTS) {
    if (
      !p.title ||
      !p.category ||
      !p.full_prompt ||
      !CATEGORIES.includes(p.category)
    ) {
      throw new Error("В prompts.json обнаружен некорректный промпт");
    }

    if (
      typeof p.price !== "number" ||
      p.price < 0 ||
      !Number.isInteger(p.price)
    ) {
      throw new Error("Некорректная цена промпта");
    }
  }

  console.log("Промпты проверены: 396, из них 4 бесплатных.");
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS limited_offers (
      offer_key TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL
    );
    INSERT INTO limited_offers(offer_key, expires_at)
    VALUES ('mini_pack_3', NOW() + INTERVAL '15 minutes')
    ON CONFLICT (offer_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT NOT NULL DEFAULT '',
      crystals INTEGER NOT NULL DEFAULT 0
        CHECK (crystals >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS first_name TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS crystals INTEGER NOT NULL DEFAULT 0 CHECK (crystals >= 0),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS legacy_balance_migrated BOOLEAN NOT NULL DEFAULT FALSE;

    DO $migrate$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'users'
          AND column_name = 'balance'
      ) THEN
        UPDATE users
        SET crystals = GREATEST(balance, 0),
            legacy_balance_migrated = TRUE
        WHERE legacy_balance_migrated = FALSE;
      ELSE
        UPDATE users
        SET legacy_balance_migrated = TRUE
        WHERE legacy_balance_migrated = FALSE;
      END IF;
    END $migrate$;

    ALTER TABLE users
      ALTER COLUMN legacy_balance_migrated SET DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      full_prompt TEXT NOT NULL,
      is_free BOOLEAN NOT NULL DEFAULT FALSE,
      price INTEGER NOT NULL DEFAULT 1
        CHECK (price >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS unlocks (
      user_id BIGINT NOT NULL REFERENCES users(telegram_id)
        ON DELETE CASCADE,
      prompt_id INTEGER NOT NULL REFERENCES prompts(id)
        ON DELETE CASCADE,
      unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, prompt_id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id BIGINT NOT NULL REFERENCES users(telegram_id)
        ON DELETE CASCADE,
      prompt_id INTEGER NOT NULL REFERENCES prompts(id)
        ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, prompt_id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(telegram_id)
        ON DELETE CASCADE,
      telegram_charge_id TEXT UNIQUE NOT NULL,
      provider_charge_id TEXT,
      stars INTEGER NOT NULL,
      crystals INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'paid',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Safe migration for databases where payments existed before Stars support.
    -- Existing rows are preserved; NULL charge IDs are allowed for legacy records.
    ALTER TABLE payments
      ADD COLUMN IF NOT EXISTS user_id BIGINT,
      ADD COLUMN IF NOT EXISTS telegram_charge_id TEXT,
      ADD COLUMN IF NOT EXISTS provider_charge_id TEXT,
      ADD COLUMN IF NOT EXISTS stars INTEGER,
      ADD COLUMN IF NOT EXISTS crystals INTEGER,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'paid',
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    CREATE UNIQUE INDEX IF NOT EXISTS payments_telegram_charge_id_uidx
      ON payments(telegram_charge_id);

    ALTER TABLE prompts
      ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

    ALTER TABLE prompts
      ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE prompts
      ADD COLUMN IF NOT EXISTS price INTEGER NOT NULL DEFAULT 1;

    ALTER TABLE unlocks
      ADD COLUMN IF NOT EXISTS unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    CREATE INDEX IF NOT EXISTS idx_prompts_category
      ON prompts(category);

    CREATE INDEX IF NOT EXISTS idx_unlocks_user
      ON unlocks(user_id, unlocked_at DESC);

    CREATE INDEX IF NOT EXISTS idx_favorites_user
      ON favorites(user_id);
  `);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (let i = 0; i < PROMPTS.length; i++) {
      const p = PROMPTS[i];

      await client.query(`
        INSERT INTO prompts(
          id, category, title, description,
          full_prompt, is_free, price
        )
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT(id) DO UPDATE SET
          category=EXCLUDED.category,
          title=EXCLUDED.title,
          description=EXCLUDED.description,
          full_prompt=EXCLUDED.full_prompt,
          is_free=EXCLUDED.is_free,
          price=EXCLUDED.price
      `, [
        i + 1,
        p.category,
        p.title,
        p.description || "",
        p.full_prompt,
        p.is_free,
        p.is_free ? 0 : p.price
      ]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.log("PostgreSQL подключена, промпты загружены.");
}

/* Проверка подлинности Telegram Mini App */

function verifyTelegramData(initData) {
  if (!initData || typeof initData !== "string") {
    return null;
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) {
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest();

  const receivedBuffer = Buffer.from(receivedHash, "hex");

  if (
    calculatedHash.length !== receivedBuffer.length ||
    !crypto.timingSafeEqual(calculatedHash, receivedBuffer)
  ) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));

  if (
    !Number.isFinite(authDate) ||
    authDate <= 0 ||
    Date.now() / 1000 - authDate > 86400 ||
    authDate - Date.now() / 1000 > 60
  ) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") || "{}");
    return Number.isSafeInteger(user.id) && user.id > 0
      ? user
      : null;
  } catch {
    return null;
  }
}

async function authenticate(req, res, next) {
  try {
    const user = verifyTelegramData(
      req.get("X-Telegram-Init-Data")
    );

    if (!user) {
      return res.status(401).json({
        error: "Откройте FRAME через Telegram"
      });
    }

    await pool.query(`
      INSERT INTO users(telegram_id, username, first_name)
      VALUES($1,$2,$3)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username=EXCLUDED.username,
        first_name=EXCLUDED.first_name,
        updated_at=NOW()
    `, [
      user.id,
      user.username || null,
      user.first_name || ""
    ]);

    req.telegramUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

/* Проверка сервера */

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "FRAME", database: "connected" });
  } catch (error) {
    console.error("Health check database error:", error);
    res.status(503).json({ ok: false, service: "FRAME", database: "disconnected" });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* Профиль */

app.get("/api/me", authenticate, async (req, res, next) => {
  try {
    const id = req.telegramUser.id;

    const user = await pool.query(`
      SELECT telegram_id, username, first_name, crystals
      FROM users
      WHERE telegram_id=$1
    `, [id]);

    const opened = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM unlocks
      WHERE user_id=$1
    `, [id]);

    res.json({
      user: user.rows[0],
      opened: opened.rows[0].count
    });
  } catch (error) {
    next(error);
  }
});

/* Каталог */

app.get("/api/prompts", authenticate, async (req, res, next) => {
  try {
    const values = [req.telegramUser.id];
    let conditions = "";

    if (req.query.category) {
      if (!CATEGORIES.includes(req.query.category)) {
        return res.status(400).json({
          error: "Неизвестная категория"
        });
      }

      values.push(req.query.category);
      conditions += ` AND p.category=$${values.length}`;
    }

    const search = String(req.query.q || "").trim().slice(0, 100);

    if (search) {
      values.push(`%${search}%`);
      conditions += `
        AND (
          p.title ILIKE $${values.length}
          OR p.description ILIKE $${values.length}
        )
      `;
    }

    const result = await pool.query(`
      SELECT
        p.id,p.category,p.title,p.description,
        p.is_free,p.price,
        (
          p.is_free OR EXISTS(
            SELECT 1 FROM unlocks u
            WHERE u.user_id=$1 AND u.prompt_id=p.id
          )
        ) AS unlocked,
        EXISTS(
          SELECT 1 FROM favorites f
          WHERE f.user_id=$1 AND f.prompt_id=p.id
        ) AS favorite
      FROM prompts p
      WHERE TRUE ${conditions}
      ORDER BY p.id
    `, values);

    res.json({
      prompts: result.rows,
      categories: CATEGORIES
    });
  } catch (error) {
    next(error);
  }
});

/* Получение полного текста */

app.get("/api/prompt/:id", authenticate, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Неверный номер промпта"
      });
    }

    const result = await pool.query(`
      SELECT p.*
      FROM prompts p
      WHERE p.id=$2
      AND (
        p.is_free OR EXISTS(
          SELECT 1 FROM unlocks u
          WHERE u.user_id=$1 AND u.prompt_id=p.id
        )
      )
    `, [req.telegramUser.id, id]);

    if (!result.rowCount) {
      return res.status(403).json({
        error: "Промпт не открыт или не существует"
      });
    }

    res.json({ prompt: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

/* Покупка промпта */

app.post("/api/unlock", authenticate, async (req, res, next) => {
  if (!PURCHASES_ENABLED) return res.status(503).json({ error: "Покупки пока не подключены" });
  const promptId = Number(req.body.promptId);

  if (!Number.isInteger(promptId) || promptId < 1) {
    return res.status(400).json({
      error: "Неверный номер промпта"
    });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const prompt = await client.query(`
      SELECT id,is_free,price
      FROM prompts
      WHERE id=$1
      FOR SHARE
    `, [promptId]);

    if (!prompt.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Промпт не найден"
      });
    }

    const already = await client.query(`
      SELECT 1 FROM unlocks
      WHERE user_id=$1 AND prompt_id=$2
    `, [req.telegramUser.id, promptId]);

    if (already.rowCount) {
      await client.query("COMMIT");

      const balance = await pool.query(
        "SELECT crystals FROM users WHERE telegram_id=$1",
        [req.telegramUser.id]
      );

      return res.json({
        ok: true,
        already: true,
        crystals: balance.rows[0].crystals
      });
    }

    const price = prompt.rows[0].is_free
      ? 0
      : prompt.rows[0].price;

    const user = await client.query(`
      SELECT crystals
      FROM users
      WHERE telegram_id=$1
      FOR UPDATE
    `, [req.telegramUser.id]);

    if (!user.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Пользователь не найден"
      });
    }

    if (user.rows[0].crystals < price) {
      await client.query("ROLLBACK");
      return res.status(402).json({
        error: "Недостаточно кристаллов"
      });
    }

    if (price > 0) {
      await client.query(`
        UPDATE users
        SET crystals=crystals-$2,updated_at=NOW()
        WHERE telegram_id=$1
      `, [req.telegramUser.id, price]);
    }

    await client.query(`
      INSERT INTO unlocks(user_id,prompt_id)
      VALUES($1,$2)
      ON CONFLICT DO NOTHING
    `, [req.telegramUser.id, promptId]);

    const updated = await client.query(
      "SELECT crystals FROM users WHERE telegram_id=$1",
      [req.telegramUser.id]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      crystals: updated.rows[0].crystals
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

/* Избранное */

app.get("/api/favorites", authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,p.category,p.title,p.description,
        p.is_free,p.price,
        (
          p.is_free OR EXISTS(
            SELECT 1 FROM unlocks u
            WHERE u.user_id=$1 AND u.prompt_id=p.id
          )
        ) AS unlocked,
        TRUE AS favorite
      FROM favorites f
      JOIN prompts p ON p.id=f.prompt_id
      WHERE f.user_id=$1
      ORDER BY f.created_at DESC
    `, [req.telegramUser.id]);

    res.json({ prompts: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post("/api/favorites/:id", authenticate, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({
        error: "Неверный номер промпта"
      });
    }

    const prompt = await pool.query(
      "SELECT id FROM prompts WHERE id=$1",
      [id]
    );

    if (!prompt.rowCount) {
      return res.status(404).json({
        error: "Промпт не найден"
      });
    }

    const deleted = await pool.query(`
      DELETE FROM favorites
      WHERE user_id=$1 AND prompt_id=$2
      RETURNING prompt_id
    `, [req.telegramUser.id, id]);

    let favorite = false;

    if (!deleted.rowCount) {
      await pool.query(`
        INSERT INTO favorites(user_id,prompt_id)
        VALUES($1,$2)
        ON CONFLICT DO NOTHING
      `, [req.telegramUser.id, id]);

      favorite = true;
    }

    res.json({ favorite });
  } catch (error) {
    next(error);
  }
});

/* История */

app.get("/api/history", authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,p.category,p.title,p.description,
        p.is_free,p.price,TRUE AS unlocked
      FROM unlocks u
      JOIN prompts p ON p.id=u.prompt_id
      WHERE u.user_id=$1
      ORDER BY u.unlocked_at DESC
    `, [req.telegramUser.id]);

    res.json({ prompts: result.rows });
  } catch (error) {
    next(error);
  }
});

/* Постоянное предложение: мини-пак 3 кристалла за 3 Stars */
app.get("/api/stars/promo", authenticate, (_req, res) => {
  res.json({ active: true });
});

/* Создание платежа Telegram Stars */
app.post("/api/stars/invoice", authenticate, async (req, res, next) => {
  if (!PURCHASES_ENABLED) return res.status(503).json({ error: "Покупки через Telegram Stars пока не подключены" });
  try {
    const pack = PACKS[req.body.pack];

    if (!pack) {
      return res.status(400).json({
        error: "Неизвестный набор кристаллов"
      });
    }

    const payload = [
      "frame",
      req.telegramUser.id,
      req.body.pack,
      crypto.randomUUID()
    ].join(":");

    const url = await bot.telegram.createInvoiceLink({
      title: pack.title,
      description: `Пополнение баланса FRAME: ${pack.crystals} кристаллов`,
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [
        {
          label: pack.title,
          amount: pack.stars
        }
      ]
    });

    res.json({ url });
  } catch (error) {
    next(error);
  }
});

/* Проверка платежа до оплаты */

bot.on("pre_checkout_query", async (ctx) => {
  if (!PURCHASES_ENABLED) {
    await ctx.answerPreCheckoutQuery(false, "Покупки пока не подключены");
    return;
  }
  try {
    const query = ctx.update.pre_checkout_query;
    const parts = String(query.invoice_payload || "").split(":");
    const pack = PACKS[parts[2]];
    const valid =
      parts.length === 4 &&
      parts[0] === "frame" &&
      Number(parts[1]) === query.from.id &&
      pack &&
      query.currency === "XTR" &&
      query.total_amount === pack.stars;

    await ctx.answerPreCheckoutQuery(
      Boolean(valid),
      valid ? undefined : "Не удалось проверить платёж"
    );
  } catch (error) {
    console.error("Ошибка проверки платежа:", error);
  }
});

/* Надёжное начисление Telegram Stars: единый идемпотентный обработчик для Update и сверки истории */
async function creditStarsPayment({ userId, username, firstName, chargeId, providerChargeId, pack, source }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO users(telegram_id, username, first_name)
       VALUES($1,$2,$3)
       ON CONFLICT(telegram_id) DO UPDATE SET
         username=COALESCE(EXCLUDED.username, users.username),
         first_name=CASE WHEN EXCLUDED.first_name <> '' THEN EXCLUDED.first_name ELSE users.first_name END,
         updated_at=NOW()`,
      [userId, username || null, firstName || ""]
    );

    const inserted = await client.query(
      `INSERT INTO payments(
         user_id, telegram_charge_id, provider_charge_id, stars, crystals, status
       )
       VALUES($1,$2,$3,$4,$5,'paid')
       ON CONFLICT(telegram_charge_id) DO NOTHING
       RETURNING id`,
      [userId, chargeId, providerChargeId || null, pack.stars, pack.crystals]
    );

    if (inserted.rowCount === 1) {
      const updated = await client.query(
        `UPDATE users
         SET crystals=crystals+$2, updated_at=NOW()
         WHERE telegram_id=$1
         RETURNING crystals`,
        [userId, pack.crystals]
      );
      if (updated.rowCount !== 1) {
        throw new Error("User balance was not updated for a confirmed Stars payment");
      }
      await client.query("COMMIT");
      console.log("FRAME PAYMENT CREDITED", {
        userId, pack: pack.key, stars: pack.stars, crystals: pack.crystals,
        balance: updated.rows[0].crystals, chargeId, source
      });
      return { credited: true, balance: updated.rows[0].crystals };
    }

    const existing = await client.query(
      "SELECT crystals FROM users WHERE telegram_id=$1",
      [userId]
    );
    await client.query("COMMIT");
    console.log("FRAME PAYMENT DUPLICATE - already processed", { userId, chargeId, source });
    return { credited: false, balance: existing.rows[0]?.crystals ?? null };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (rollbackError) {
      console.error("FRAME payment rollback failed:", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

/* Telegram StarTransaction.id совпадает с SuccessfulPayment.telegram_payment_charge_id.
   Сверка истории использует тот же ключ защиты от двойного начисления. */
async function reconcileStarsPayments(targetUserId = null, notifyUsers = true) {
  const history = await bot.telegram.callApi("getStarTransactions", {
    offset: 0,
    limit: 100
  });
  const transactions = Array.isArray(history?.transactions) ? history.transactions : [];
  let found = 0;
  let credited = 0;
  let creditedCrystals = 0;

  for (const tx of transactions) {
    const source = tx?.source;
    const payload = source?.invoice_payload;
    if (source?.type !== "user" || typeof payload !== "string" || !payload.startsWith("frame:")) continue;

    const parts = payload.split(":");
    const userId = Number(parts[1]);
    const pack = PACKS[parts[2]];
    const sourceUserId = Number(source.user?.id);

    if (
      parts.length !== 4 ||
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      sourceUserId !== userId ||
      (targetUserId !== null && userId !== Number(targetUserId)) ||
      !pack ||
      Number(tx.amount) !== pack.stars ||
      !tx.id
    ) continue;

    found += 1;
    const result = await creditStarsPayment({
      userId,
      username: source.user?.username || null,
      firstName: source.user?.first_name || "",
      chargeId: String(tx.id),
      providerChargeId: null,
      pack: { ...pack, key: parts[2] },
      source: "stars_history"
    });

    if (result.credited) {
      credited += 1;
      creditedCrystals += pack.crystals;
      if (notifyUsers) {
        try {
          await bot.telegram.sendMessage(
            userId,
            `💎 Оплату ${pack.stars} ⭐ нашёл в истории Telegram. Начислено ${pack.crystals} кристаллов. Текущий баланс: ${result.balance} 💎`
          );
        } catch (notifyError) {
          console.error("FRAME PAYMENT RECOVERY NOTIFICATION ERROR", {
            userId, chargeId: tx.id, error: notifyError.message
          });
        }
      }
    }
  }

  return { scanned: transactions.length, found, credited, creditedCrystals };
}

/* Диагностика каждого подтверждённого платёжного Update */
bot.use(async (ctx, next) => {
  if (ctx.message?.successful_payment) {
    const p = ctx.message.successful_payment;
    console.log("FRAME SUCCESSFUL_PAYMENT UPDATE RECEIVED", {
      userId: ctx.from?.id,
      currency: p.currency,
      total: p.total_amount,
      payloadPresent: Boolean(p.invoice_payload),
      chargeIdPresent: Boolean(p.telegram_payment_charge_id)
    });
  }
  return next();
});

/* Начисление сразу после successful_payment Update */
bot.on("message", async (ctx, next) => {
  const payment = ctx.message?.successful_payment;
  // Пропускаем все обычные сообщения дальше, чтобы команды /start, /app,
  // /paysupport и остальные обработчики Telegraf продолжали работать.
  if (!payment || !PURCHASES_ENABLED) return next();

  const parts = String(payment.invoice_payload || "").split(":");
  const userId = Number(parts[1]);
  const pack = PACKS[parts[2]];

  if (
    parts.length !== 4 ||
    parts[0] !== "frame" ||
    !Number.isSafeInteger(userId) ||
    userId !== ctx.from.id ||
    !pack ||
    payment.currency !== "XTR" ||
    payment.total_amount !== pack.stars ||
    !payment.telegram_payment_charge_id
  ) {
    console.error("FRAME PAYMENT REJECTED: invalid successful_payment payload", {
      from: ctx.from?.id, payload: payment.invoice_payload,
      currency: payment.currency, total: payment.total_amount
    });
    return;
  }

  try {
    const result = await creditStarsPayment({
      userId,
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || "",
      chargeId: payment.telegram_payment_charge_id,
      providerChargeId: payment.provider_payment_charge_id || null,
      pack: { ...pack, key: parts[2] },
      source: "successful_payment_update"
    });

    if (result.credited) {
      await ctx.reply(
        `✨ Оплата прошла успешно!\n\n💎 Начислено: ${pack.crystals} кристаллов.\nБаланс обновлён: ${result.balance} 💎`
      );
    } else {
      await ctx.reply(`Этот платёж уже обработан. Текущий баланс: ${result.balance} 💎`);
    }
  } catch (error) {
    console.error("FRAME PAYMENT CREDIT ERROR", {
      userId, chargeId: payment.telegram_payment_charge_id,
      error: error.stack || error.message
    });
    try {
      await ctx.reply("Платёж подтверждён Telegram, но начисление задерживается. FRAME автоматически повторит сверку — повторно платить не нужно.");
    } catch (replyError) {
      console.error("Could not notify user about payment issue:", replyError.message);
    }
  }
});

/* Ручная проверка + немедленная сверка пропущенных Stars-платежей */
bot.command("paysupport", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  await ctx.reply("🔎 Проверяю подтверждённые платежи Telegram Stars…");
  try {
    const result = await reconcileStarsPayments(userId, false);
    const balance = await pool.query(
      "SELECT crystals FROM users WHERE telegram_id=$1", [userId]
    );
    const crystals = balance.rows[0]?.crystals ?? 0;

    if (result.credited > 0) {
      await ctx.reply(`✅ Нашёл оплату и начислил ${result.creditedCrystals} кристаллов. Текущий баланс: ${crystals} 💎`);
    } else if (result.found > 0) {
      await ctx.reply(`Платёж найден, но уже был учтён ранее. Текущий баланс: ${crystals} 💎`);
    } else {
      await ctx.reply(`В последних ${result.scanned} транзакциях не нашёл неоплаченный счёт FRAME для твоего аккаунта. Баланс: ${crystals} 💎. Повторно платить не нужно.`);
    }
  } catch (error) {
    console.error("FRAME PAY SUPPORT ERROR", {
      userId, error: error.stack || error.message
    });
    await ctx.reply("Не удалось проверить историю Stars сейчас. Повторно не плати — автоматическая сверка продолжит работу.");
  }
});

/* Автоматическая сверка защищает от потерянных Telegram Updates и временных ошибок БД */
let starsReconciliationRunning = false;
async function runStarsReconciliation() {
  if (starsReconciliationRunning) return;
  starsReconciliationRunning = true;
  try {
    const result = await reconcileStarsPayments(null, true);
    if (result.credited > 0) console.log("FRAME AUTOMATIC STARS RECONCILIATION", result);
  } catch (error) {
    console.error("FRAME AUTOMATIC STARS RECONCILIATION ERROR", error.stack || error.message);
  } finally {
    starsReconciliationRunning = false;
  }
}

/* Команды Telegram */

bot.start(async (ctx) => {
  await ctx.reply(
    "✨ Добро пожаловать в FRAME!\n\nТвой магазин готовых промптов.\n\n💎 Открывай идеи, сохраняй любимые и создавай истории!",
    Markup.inlineKeyboard([
      [
        Markup.button.webApp(
          "✨ Открыть FRAME",
          MINI_APP_URL
        )
      ]
    ])
  );
});

bot.command("app", async (ctx) => {
  await ctx.reply(
    "Открывай магазин FRAME:",
    Markup.inlineKeyboard([
      [
        Markup.button.webApp(
          "✨ Открыть магазин",
          MINI_APP_URL
        )
      ]
    ])
  );
});

/* Обработка ошибок */

app.use((error, req, res, next) => {
  console.error("Server error:", error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: "Внутренняя ошибка сервера"
  });
});

/* Запуск */

async function startBotWithRetry() {
  let attempt = 0;

  while (true) {
    try {
      await bot.launch({ allowedUpdates: ["message", "pre_checkout_query"] });
      console.log("FRAME Telegram bot started (message + pre_checkout_query updates enabled)");
      void runStarsReconciliation();
      const reconciliationTimer = setInterval(() => void runStarsReconciliation(), 30000);
      if (typeof reconciliationTimer.unref === "function") reconciliationTimer.unref();
      return;
    } catch (error) {
      attempt += 1;
      const delay = Math.min(30000, 5000 * attempt);
      console.error(
        `Telegram API connection failed (attempt ${attempt}). Retrying in ${delay / 1000}s:`,
        error.message
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function main() {
  validatePrompts();
  await initDatabase();

  // Постоянная кнопка Mini App в меню чата Telegram
  try {
    await bot.telegram.callApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Открыть FRAME",
        web_app: { url: MINI_APP_URL }
      }
    });
    console.log("FRAME chat menu button configured");
  } catch (error) {
    console.error("Could not configure FRAME chat menu button:", error.message);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`FRAME server started on port ${PORT}`);
  });

  startBotWithRetry().catch(error => {
    console.error("Telegram retry loop failed:", error);
  });
}

main().catch(error => {
  console.error("FRAME startup error:", error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
