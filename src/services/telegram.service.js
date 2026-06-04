import { prisma } from "../config/prisma.js";
import { escapeHtml, formatPrice, paymentLabels } from "../utils/format.js";

const settingsId = "singleton";
const LOW_STOCK_THRESHOLD = 3;

export const defaultTelegramSettings = {
  botToken: "",
  chatId: "",
  newSale: true,
  dailyReport: true,
  returns: true,
  lowStock: true,
  outOfStock: true,
  shiftOpen: true,
  shiftClose: true,
};

const normalizeTelegramSettings = (data = {}) => ({
  botToken: data.botToken || "",
  chatId: data.chatId || "",
  newSale: Boolean(data.newSale),
  dailyReport: Boolean(data.dailyReport),
  returns: Boolean(data.returns),
  lowStock: Boolean(data.lowStock),
  outOfStock: Boolean(data.outOfStock),
  shiftOpen: Boolean(data.shiftOpen),
  shiftClose: Boolean(data.shiftClose),
});

export const getTelegramSettings = async () =>
  prisma.telegramSettings.upsert({
    where: { id: settingsId },
    update: {},
    create: { id: settingsId, ...defaultTelegramSettings },
  });

export const updateTelegramSettings = async (data) =>
  prisma.telegramSettings.upsert({
    where: { id: settingsId },
    create: {
      id: settingsId,
      ...defaultTelegramSettings,
      ...normalizeTelegramSettings(data),
    },
    update: normalizeTelegramSettings(data),
  });

export const sendTelegramMessage = async (message, eventType) => {
  const settings = await getTelegramSettings();

  if (!settings.botToken || !settings.chatId) return { skipped: true };
  if (eventType && settings[eventType] === false) return { skipped: true };

  const response = await fetch(
    `https://api.telegram.org/bot${settings.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: settings.chatId,
        text: message,
        parse_mode: "HTML",
      }),
    },
  );

  return response.json();
};

const productList = (items = []) =>
  items
    .map((item, index) => {
      const originalPrice = Number(
        item.originalPrice ?? item.price ?? item.sellPrice ?? 0,
      );
      const finalPrice = Number(
        item.finalPrice ?? item.price ?? item.sellPrice ?? 0,
      );
      const discount = Math.max(0, originalPrice - finalPrice);
      const discountText =
        discount > 0 ? ` (chegirma ${formatPrice(discount)} / dona)` : "";

      return `${index + 1}. ${escapeHtml(item.name)} - ${Number(
        item.quantity || 0,
      )} dona x ${formatPrice(finalPrice)}${discountText}`;
    })
    .join("\n");

export const notifyNewSale = (sale) =>
  sendTelegramMessage(
    [
      "🛒 <b>Yangi savdo</b>",
      "",
      `👤 <b>Sotuvchi:</b> ${escapeHtml(sale.sellerName || "Noma'lum")}`,
      ...(Number(sale.saleDiscountTotal || 0) > 0
        ? [`<b>Chegirma:</b> ${formatPrice(sale.saleDiscountTotal)}`]
        : []),
      `💰 <b>Summa:</b> ${formatPrice(sale.total)}`,
      `💳 <b>To'lov turi:</b> ${paymentLabels[sale.paymentMethod] || "Noma'lum"}`,
      `🕒 <b>Vaqt:</b> ${escapeHtml(sale.time || "")}`,
      "",
      "<b>Mahsulotlar:</b>",
      productList(sale.items),
    ].join("\n"),
    "newSale",
  );

export const notifyDailyReport = (report) =>
  sendTelegramMessage(
    [
      "📊 <b>Kunlik hisobot</b>",
      "",
      `📅 <b>Sana:</b> ${escapeHtml(report.date || "")}`,
      `💰 <b>Jami savdo:</b> ${formatPrice(report.total)}`,
      `💵 <b>Naqd:</b> ${formatPrice(report.cash)}`,
      `💳 <b>Karta:</b> ${formatPrice(report.card)}`,
      `🏦 <b>O'tkazma:</b> ${formatPrice(report.transfer)}`,
      `🧾 <b>Tranzaksiyalar:</b> ${Number(report.count || 0)} ta`,
      `👤 <b>Yakunlagan xodim:</b> ${escapeHtml(report.closedBy || "Noma'lum")}`,
    ].join("\n"),
    "dailyReport",
  );

export const notifyReturn = (returnItem) =>
  sendTelegramMessage(
    [
      "↩️ <b>Vozvrat</b>",
      "",
      `📦 <b>Mahsulot:</b> ${escapeHtml(returnItem.productName)}`,
      `🔢 <b>Miqdor:</b> ${Number(returnItem.quantity || 0)} dona`,
      `💰 <b>Summa:</b> ${formatPrice(returnItem.amount)}`,
      `📝 <b>Sabab:</b> ${escapeHtml(returnItem.reason || "Ko'rsatilmagan")}`,
      `👤 <b>Xodim:</b> ${escapeHtml(returnItem.sellerName || "Noma'lum")}`,
    ].join("\n"),
    "returns",
  );

export const notifyLowStock = (item) =>
  sendTelegramMessage(
    [
      "⚠️ <b>Kam qolgan mahsulot</b>",
      "",
      `📦 <b>Mahsulot:</b> ${escapeHtml(item.name)}`,
      `🏷️ <b>SKU:</b> ${escapeHtml(item.sku || "SKU yo'q")}`,
      `📉 <b>Qoldiq:</b> ${Number(item.quantity || 0)} dona`,
    ].join("\n"),
    "lowStock",
  );

export const notifyOutOfStock = (item) =>
  sendTelegramMessage(
    [
      "🚫 <b>Mahsulot tugadi</b>",
      "",
      `📦 <b>Mahsulot:</b> ${escapeHtml(item.name)}`,
      `🏷️ <b>SKU:</b> ${escapeHtml(item.sku || "SKU yo'q")}`,
      "📉 <b>Qoldiq:</b> 0 dona",
    ].join("\n"),
    "outOfStock",
  );

export const notifyStockChange = async (previousQty, product) => {
  const nextQty = Number(product.quantity || 0);

  if (nextQty === 0 && previousQty !== 0) {
    await notifyOutOfStock(product);
    return;
  }

  if (
    Number(previousQty) > LOW_STOCK_THRESHOLD &&
    nextQty > 0 &&
    nextQty <= LOW_STOCK_THRESHOLD
  ) {
    await notifyLowStock(product);
  }
};

export const notifyShiftOpen = (shift) =>
  sendTelegramMessage(
    [
      "🟢 <b>Shift ochildi</b>",
      "",
      `👤 <b>Kassir:</b> ${escapeHtml(shift.cashierName)}`,
      `💵 <b>Boshlang'ich kassa:</b> ${formatPrice(shift.openingCash)}`,
      `🕒 <b>Vaqt:</b> ${escapeHtml(shift.openedAt)}`,
    ].join("\n"),
    "shiftOpen",
  );

export const notifyShiftClose = (shift) =>
  sendTelegramMessage(
    [
      "🔴 <b>Shift yopildi</b>",
      "",
      `👤 <b>Kassir:</b> ${escapeHtml(shift.cashierName)}`,
      `💵 <b>Yakuniy kassa:</b> ${formatPrice(shift.closingCash)}`,
      `💰 <b>Bugungi savdo:</b> ${formatPrice(shift.totalSales)}`,
      `💵 <b>Naqd:</b> ${formatPrice(shift.cashSales)}`,
      `💳 <b>Karta:</b> ${formatPrice(shift.cardSales)}`,
      `🏦 <b>O'tkazma:</b> ${formatPrice(shift.transferSales)}`,
      `🧾 <b>Tranzaksiyalar:</b> ${Number(shift.transactions || 0)} ta`,
      `🕒 <b>Vaqt:</b> ${escapeHtml(shift.closedAt || "")}`,
    ].join("\n"),
    "shiftClose",
  );

export const sendTelegramEvent = (type, payload) => {
  const handlers = {
    newSale: notifyNewSale,
    dailyReport: notifyDailyReport,
    returns: notifyReturn,
    lowStock: notifyLowStock,
    outOfStock: notifyOutOfStock,
    shiftOpen: notifyShiftOpen,
    shiftClose: notifyShiftClose,
  };

  return handlers[type]?.(payload) || Promise.resolve({ skipped: true });
};
