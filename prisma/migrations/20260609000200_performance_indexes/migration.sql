-- Store-scoped read paths used by bootstrap, dashboard, history, and store switch.
CREATE INDEX IF NOT EXISTS "Product_storeId_isDeleted_createdAt_idx"
  ON "Product"("storeId", "isDeleted", "createdAt");

CREATE INDEX IF NOT EXISTS "Sale_storeId_status_dateISO_createdAt_idx"
  ON "Sale"("storeId", "status", "dateISO", "createdAt");

CREATE INDEX IF NOT EXISTS "Return_storeId_createdAt_idx"
  ON "Return"("storeId", "createdAt");

CREATE INDEX IF NOT EXISTS "Supplier_storeId_createdAt_idx"
  ON "Supplier"("storeId", "createdAt");

CREATE INDEX IF NOT EXISTS "Expense_storeId_createdAt_idx"
  ON "Expense"("storeId", "createdAt");

CREATE INDEX IF NOT EXISTS "Shift_storeId_status_closedAtISO_idx"
  ON "Shift"("storeId", "status", "closedAtISO");
