import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const main = async () => {
  console.log("TECHPRO reset-data: cleaning operational data...");

  const result = await prisma.$transaction(
    async (tx) => {
      const deletedReturns = await tx.return.deleteMany();
      const deletedSaleItems = await tx.saleItem.deleteMany();
      const deletedSales = await tx.sale.deleteMany();
      const deletedSalesDays = await tx.salesDay.deleteMany();
      const deletedExpenses = await tx.expense.deleteMany();
      const deletedShifts = await tx.shift.deleteMany();

      const deletedSupplierTransactions =
        await tx.supplierTransaction.deleteMany();

      const deletedSuppliers = await tx.supplier.deleteMany();
      const deletedActivityLogs = await tx.activityLog.deleteMany();
      const deletedTelegramSettings = await tx.telegramSettings.deleteMany();
      const deletedProducts = await tx.product.deleteMany();

      return {
        returns: deletedReturns.count,
        saleItems: deletedSaleItems.count,
        sales: deletedSales.count,
        salesDays: deletedSalesDays.count,
        expenses: deletedExpenses.count,
        shifts: deletedShifts.count,
        supplierTransactions: deletedSupplierTransactions.count,
        suppliers: deletedSuppliers.count,
        activityLogs: deletedActivityLogs.count,
        telegramSettings: deletedTelegramSettings.count,
        products: deletedProducts.count,
      };
    },
    {
      timeout: 30000,
      maxWait: 30000,
    },
  );

  const usersCount = await prisma.user.count();

  console.log("TECHPRO reset-data: done.");
  console.table(result);
  console.log(`Users kept: ${usersCount}`);
};

main()
  .catch((error) => {
    console.error("TECHPRO reset-data failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
