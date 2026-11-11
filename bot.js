const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL;

app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.send("FRAME работает!");
});

app.listen(PORT, () => {
  console.log("FRAME запущен на порту " + PORT);
});

if (!BOT_TOKEN) {
  console.log("Добавь BOT_TOKEN в переменные окружения.");
  process.exit(1);
}

if (!WEB_APP_URL) {
  console.log("Добавь WEB_APP_URL в переменные окружения.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  await ctx.reply(
    "✨ Добро пожаловать в FRAME!\n\n" +
    "Твоя библиотека необычных историй и идей для видео.\n\n" +
    "💎 Открывай промпты, собирай избранное и создавай собственные видео!",
    Markup.inlineKeyboard([
      Markup.button.webApp("🚀 Открыть FRAME", WEB_APP_URL)
    ])
  );
});

bot.command("help", (ctx) => {
  ctx.reply("Нажми /start, чтобы открыть FRAME.");
});

bot.catch((err) => {
  console.error("Ошибка бота:", err);
});

bot.launch()
  .then(() => console.log("🤖 FRAME Telegram Bot запущен!"))
  .catch((err) => console.error("Ошибка запуска:", err));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));