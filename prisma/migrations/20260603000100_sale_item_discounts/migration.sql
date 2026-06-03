ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "saleSubtotal" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "saleDiscountTotal" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "saleTotal" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "originalPrice" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "finalPrice" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "itemDiscountPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "itemDiscountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "SaleItem"
SET
  "originalPrice" = CASE WHEN "originalPrice" = 0 THEN "price" ELSE "originalPrice" END,
  "finalPrice" = CASE WHEN "finalPrice" = 0 THEN "price" ELSE "finalPrice" END;

UPDATE "Sale"
SET
  "saleSubtotal" = COALESCE((
    SELECT SUM(COALESCE(NULLIF(si."originalPrice", 0), si."price") * si."quantity")
    FROM "SaleItem" si
    WHERE si."saleId" = "Sale"."id"
  ), "total", 0),
  "saleDiscountTotal" = COALESCE((
    SELECT SUM(
      GREATEST(
        0,
        COALESCE(NULLIF(si."originalPrice", 0), si."price") -
        COALESCE(NULLIF(si."finalPrice", 0), si."price")
      ) * si."quantity"
    )
    FROM "SaleItem" si
    WHERE si."saleId" = "Sale"."id"
  ), 0),
  "saleTotal" = CASE WHEN "saleTotal" = 0 THEN "total" ELSE "saleTotal" END;
