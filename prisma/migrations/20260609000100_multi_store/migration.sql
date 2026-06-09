-- Multi-store support for TechPro.
-- Existing production data is attached to dokon-1; dokon-2 starts empty.

CREATE TABLE IF NOT EXISTS "Store" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Store_name_key" ON "Store"("name");

INSERT INTO "Store" ("id", "name")
VALUES
  ('dokon-1', 'dokon-1'),
  ('dokon-2', 'dokon-2')
ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name";

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "storeId" TEXT;

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "SalesDay" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "Return" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "Supplier" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "SupplierTransaction" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "Shift" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "storeId" TEXT;
ALTER TABLE "TelegramSettings" ADD COLUMN IF NOT EXISTS "storeId" TEXT;

UPDATE "Product" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;
UPDATE "Sale" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;
UPDATE "SalesDay" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;
UPDATE "Return" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;
UPDATE "Supplier" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;
UPDATE "Expense" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;
UPDATE "Shift" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;
UPDATE "ActivityLog" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;

UPDATE "SaleItem" si
SET "storeId" = COALESCE(s."storeId", 'dokon-1')
FROM "Sale" s
WHERE si."saleId" = s."id" AND si."storeId" IS NULL;
UPDATE "SaleItem" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;

UPDATE "SupplierTransaction" st
SET "storeId" = COALESCE(s."storeId", 'dokon-1')
FROM "Supplier" s
WHERE st."supplierId" = s."id" AND st."storeId" IS NULL;
UPDATE "SupplierTransaction" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;

UPDATE "TelegramSettings" SET "storeId" = 'dokon-1' WHERE "storeId" IS NULL;
INSERT INTO "TelegramSettings" (
  "id",
  "storeId",
  "botToken",
  "chatId",
  "newSale",
  "dailyReport",
  "returns",
  "lowStock",
  "outOfStock",
  "shiftOpen",
  "shiftClose"
)
SELECT
  'telegram-dokon-2',
  'dokon-2',
  '',
  '',
  true,
  true,
  true,
  true,
  true,
  true,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM "TelegramSettings" WHERE "storeId" = 'dokon-2'
);

UPDATE "User"
SET "storeId" = CASE
  WHEN "role" = 'admin' THEN NULL
  WHEN "username" = 'sotuvchi2' THEN 'dokon-2'
  ELSE COALESCE("storeId", 'dokon-1')
END;

ALTER TABLE "Product" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "Sale" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "SaleItem" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "SalesDay" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "Return" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "Supplier" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "SupplierTransaction" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "Expense" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "Shift" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "ActivityLog" ALTER COLUMN "storeId" SET NOT NULL;
ALTER TABLE "TelegramSettings" ALTER COLUMN "storeId" SET NOT NULL;

DROP INDEX IF EXISTS "Product_sku_key";
DROP INDEX IF EXISTS "Product_barcode_key";
DROP INDEX IF EXISTS "SalesDay_dateISO_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Product_storeId_sku_key" ON "Product"("storeId", "sku");
CREATE UNIQUE INDEX IF NOT EXISTS "Product_storeId_barcode_key" ON "Product"("storeId", "barcode");
CREATE UNIQUE INDEX IF NOT EXISTS "SalesDay_storeId_dateISO_key" ON "SalesDay"("storeId", "dateISO");
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramSettings_storeId_key" ON "TelegramSettings"("storeId");

CREATE INDEX IF NOT EXISTS "User_storeId_idx" ON "User"("storeId");
CREATE INDEX IF NOT EXISTS "Product_storeId_idx" ON "Product"("storeId");
CREATE INDEX IF NOT EXISTS "Sale_storeId_status_dateISO_idx" ON "Sale"("storeId", "status", "dateISO");
CREATE INDEX IF NOT EXISTS "SaleItem_storeId_idx" ON "SaleItem"("storeId");
CREATE INDEX IF NOT EXISTS "SalesDay_storeId_dateISO_idx" ON "SalesDay"("storeId", "dateISO");
CREATE INDEX IF NOT EXISTS "Return_storeId_dateISO_idx" ON "Return"("storeId", "dateISO");
CREATE INDEX IF NOT EXISTS "Supplier_storeId_idx" ON "Supplier"("storeId");
CREATE INDEX IF NOT EXISTS "SupplierTransaction_storeId_supplierId_createdAt_idx" ON "SupplierTransaction"("storeId", "supplierId", "createdAt");
CREATE INDEX IF NOT EXISTS "Expense_storeId_idx" ON "Expense"("storeId");
CREATE INDEX IF NOT EXISTS "Shift_storeId_status_idx" ON "Shift"("storeId", "status");
CREATE INDEX IF NOT EXISTS "ActivityLog_storeId_createdAt_idx" ON "ActivityLog"("storeId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_storeId_fkey') THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Product_storeId_fkey') THEN
    ALTER TABLE "Product" ADD CONSTRAINT "Product_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Sale_storeId_fkey') THEN
    ALTER TABLE "Sale" ADD CONSTRAINT "Sale_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SaleItem_storeId_fkey') THEN
    ALTER TABLE "SaleItem" ADD CONSTRAINT "SaleItem_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SalesDay_storeId_fkey') THEN
    ALTER TABLE "SalesDay" ADD CONSTRAINT "SalesDay_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Return_storeId_fkey') THEN
    ALTER TABLE "Return" ADD CONSTRAINT "Return_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Supplier_storeId_fkey') THEN
    ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SupplierTransaction_storeId_fkey') THEN
    ALTER TABLE "SupplierTransaction" ADD CONSTRAINT "SupplierTransaction_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Expense_storeId_fkey') THEN
    ALTER TABLE "Expense" ADD CONSTRAINT "Expense_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Shift_storeId_fkey') THEN
    ALTER TABLE "Shift" ADD CONSTRAINT "Shift_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityLog_storeId_fkey') THEN
    ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TelegramSettings_storeId_fkey') THEN
    ALTER TABLE "TelegramSettings" ADD CONSTRAINT "TelegramSettings_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
