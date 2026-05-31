export const formatPrice = (value) =>
  `${Number(value || 0).toLocaleString("uz-UZ")} so'm`;

export const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const paymentLabels = {
  cash: "Naqd",
  card: "Karta",
  transfer: "O'tkazma",
};
