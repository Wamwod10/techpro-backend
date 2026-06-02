import { prisma } from "../config/prisma.js";

const requiredColumns = {
  User: ["id", "name", "username", "email", "password", "role", "createdAt", "updatedAt"],
  Product: [
    "id",
    "name",
    "sku",
    "barcode",
    "category",
    "quantity",
    "costPrice",
    "sellPrice",
    "price",
    "stock",
    "supplier",
    "returnDays",
    "paymentStatus",
    "debtAmount",
    "supplierPhone",
    "date",
    "isDeleted",
    "deletedAt",
    "createdAt",
    "updatedAt",
  ],
  Sale: [
    "id",
    "dateISO",
    "date",
    "time",
    "total",
    "returnedTotal",
    "paymentMethod",
    "status",
    "sellerId",
    "sellerName",
    "sellerRole",
    "createdAt",
    "updatedAt",
  ],
  SaleItem: [
    "id",
    "saleId",
    "productId",
    "name",
    "sku",
    "quantity",
    "price",
    "costPrice",
    "returnedQty",
    "returnStatus",
  ],
  SalesDay: [
    "id",
    "dateISO",
    "date",
    "total",
    "cash",
    "card",
    "transfer",
    "returnedTotal",
    "count",
    "closedBy",
    "autoClosed",
    "createdAt",
    "updatedAt",
  ],
  Return: [
    "id",
    "saleId",
    "saleItemId",
    "productId",
    "productName",
    "sku",
    "quantity",
    "amount",
    "reason",
    "paymentMethod",
    "sellerId",
    "sellerName",
    "sellerRole",
    "date",
    "dateISO",
    "time",
    "createdAt",
  ],
  Supplier: ["id", "name", "phone", "address", "notes", "debt", "paid", "deadline", "createdAt", "updatedAt"],
  SupplierTransaction: [
    "id",
    "supplierId",
    "type",
    "status",
    "productName",
    "amount",
    "phone",
    "date",
    "time",
    "note",
    "createdAt",
  ],
  Expense: ["id", "title", "category", "amount", "note", "date", "createdAt", "updatedAt"],
  Shift: [
    "id",
    "cashierName",
    "openedById",
    "openedByName",
    "closedById",
    "closedByName",
    "openingCash",
    "closingCash",
    "cashDifference",
    "totalSales",
    "cashSales",
    "cardSales",
    "transferSales",
    "transactions",
    "openedAt",
    "openedAtISO",
    "closedAt",
    "closedAtISO",
    "duration",
    "date",
    "status",
    "createdAt",
    "updatedAt",
  ],
  ActivityLog: ["id", "type", "title", "description", "userId", "userName", "userRole", "date", "time", "createdAt"],
  TelegramSettings: [
    "id",
    "botToken",
    "chatId",
    "newSale",
    "dailyReport",
    "returns",
    "lowStock",
    "outOfStock",
    "shiftOpen",
    "shiftClose",
    "createdAt",
    "updatedAt",
  ],
};

const requiredMigrations = [
  "20260602000100_supplier_notes",
  "20260602000200_schema_alignment",
];

export const verifyPrismaSchema = async () => {
  try {
    const columns = await prisma.$queryRaw`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `;

    const existing = new Set(
      columns.map((column) => `${column.table_name}.${column.column_name}`),
    );
    const missing = Object.entries(requiredColumns).flatMap(([table, tableColumns]) =>
      tableColumns
        .filter((column) => !existing.has(`${table}.${column}`))
        .map((column) => `${table}.${column}`),
    );

    const migrations = await prisma.$queryRaw`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
    `.catch(() => []);

    const appliedMigrations = new Set(
      migrations.map((migration) => migration.migration_name),
    );
    const missingMigrations = requiredMigrations.filter(
      (migration) => !appliedMigrations.has(migration),
    );

    if (missing.length || missingMigrations.length) {
      console.error("[DB SCHEMA MISMATCH] Prisma migrations are not fully applied.", {
        missingColumns: missing,
        missingMigrations,
        fix: "Run `npx prisma migrate deploy` before starting the backend.",
      });
      return;
    }

    console.log("[DB SCHEMA CHECK] Prisma schema and database columns look aligned.");
  } catch (error) {
    console.error("[DB SCHEMA CHECK FAILED] Could not verify database schema.", {
      message: error.message,
      fix: "Check DATABASE_URL and run `npx prisma migrate deploy`.",
    });
  }
};
