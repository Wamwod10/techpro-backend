-- Associate each sale with the active shift when possible.
ALTER TABLE "Sale" ADD COLUMN "shiftId" TEXT;

ALTER TABLE "Sale"
ADD CONSTRAINT "Sale_shiftId_fkey"
FOREIGN KEY ("shiftId") REFERENCES "Shift"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Sale_shiftId_idx" ON "Sale"("shiftId");
