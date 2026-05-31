import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../config/prisma.js";
import { env } from "../config/env.js";
import { requireAuth, requireRole } from "../middlewares/auth.js";
import { formatDuration, toISODate, toUzDate, toUzTime } from "../utils/datetime.js";
import {
  getTelegramSettings,
  notifyDailyReport,
  notifyNewSale,
  notifyReturn,
  notifyShiftClose,
  notifyShiftOpen,
  notifyStockChange,
  sendTelegramEvent,
  sendTelegramMessage,
  updateTelegramSettings,
} from "../services/telegram.service.js";

const router = Router();

const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const saleInclude = {
  items: true,
};

const getCanonicalQuantity = (product) => {
  const quantity = Number(product?.quantity ?? 0);
  const legacyStock = Number(product?.stock ?? 0);

  if (quantity <= 0 && legacyStock > 0) {
    return legacyStock;
  }

  return Math.max(0, quantity);
};

const isCreditPayment = (status) =>
  ["credit", "debt", "qarz"].includes(String(status || "").toLowerCase());

const normalizePaymentStatus = (status) =>
  isCreditPayment(status) ? "credit" : "paid";

const normalizeProductInput = (data) => {
  const quantity = Math.max(0, Number(data.quantity ?? data.stock ?? 0));
  const sellPrice = Number(data.sellPrice ?? data.price ?? 0);
  const paymentStatus = normalizePaymentStatus(data.paymentStatus);

  return {
    name: data.name,
    sku: data.sku || null,
    barcode: data.barcode || null,
    category: data.category || "Boshqa",
    quantity,
    stock: quantity,
    costPrice: Number(data.costPrice || 0),
    sellPrice,
    price: sellPrice,
    supplier: data.supplierName || data.supplier || "",
    returnDays: data.returnDays || "",
    paymentStatus,
    debtAmount: isCreditPayment(paymentStatus) ? Number(data.debtAmount || 0) : 0,
    supplierPhone: data.supplierPhone || "",
    date: data.date || null,
  };
};

const normalizeSupplierInput = (data) => ({
  name: data.name || data.supplierName || "",
  phone: data.phone || data.supplierPhone || null,
  address: data.address || null,
  debt: Number(data.debt || 0),
  paid: Number(data.paid || 0),
  deadline: data.deadline || null,
});

const toSupplierDto = (supplier) => ({
  ...supplier,
  orders: supplier.transactions || [],
});

const findSupplierByName = (client, name) =>
  client.supplier.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
    include: { transactions: { orderBy: { createdAt: "desc" } } },
  });

const applySupplierDebtChange = async (
  client,
  { supplierName, supplierPhone, amount, productName, date, note },
) => {
  const cleanSupplierName = String(supplierName || "").trim();
  const debtAmount = Number(amount || 0);

  if (!cleanSupplierName || debtAmount === 0) {
    return null;
  }

  const existingSupplier = await findSupplierByName(client, cleanSupplierName);
  const transactionStatus = debtAmount > 0 ? "Qarz" : "Tuzatish";

  if (!existingSupplier) {
    const supplier = await client.supplier.create({
      data: {
        name: cleanSupplierName,
        phone: supplierPhone || null,
        debt: Math.max(0, debtAmount),
        paid: 0,
        deadline: date || null,
        transactions: {
          create: {
            type: debtAmount > 0 ? "inventory" : "adjustment",
            status: transactionStatus,
            productName,
            amount: Math.abs(debtAmount),
            phone: supplierPhone || null,
            date: date || toUzDate(),
            time: toUzTime(),
            note,
          },
        },
      },
      include: { transactions: { orderBy: { createdAt: "desc" } } },
    });

    return supplier;
  }

  const nextDebt = Math.max(0, Number(existingSupplier.debt || 0) + debtAmount);

  const supplier = await client.supplier.update({
    where: { id: existingSupplier.id },
    data: {
      phone: supplierPhone || existingSupplier.phone,
      deadline: existingSupplier.deadline || date || null,
      debt: nextDebt,
      transactions: {
        create: {
          type: debtAmount > 0 ? "inventory" : "adjustment",
          status: transactionStatus,
          productName,
          amount: Math.abs(debtAmount),
          phone: supplierPhone || existingSupplier.phone,
          date: date || toUzDate(),
          time: toUzTime(),
          note,
        },
      },
    },
    include: { transactions: { orderBy: { createdAt: "desc" } } },
  });

  return supplier;
};

const getDebtAdjustment = (previousProduct, nextProduct) => {
  const previousDebt = isCreditPayment(previousProduct?.paymentStatus)
    ? Number(previousProduct?.debtAmount || 0)
    : 0;
  const nextDebt = isCreditPayment(nextProduct.paymentStatus)
    ? Number(nextProduct.debtAmount || 0)
    : 0;
  const previousSupplier = String(previousProduct?.supplier || "").trim();
  const nextSupplier = String(nextProduct.supplier || "").trim();

  if (!previousProduct) {
    return nextDebt;
  }

  if (
    previousSupplier &&
    nextSupplier &&
    previousSupplier.toLowerCase() !== nextSupplier.toLowerCase()
  ) {
    return nextDebt;
  }

  return nextDebt - previousDebt;
};

const toProductDto = (product) => ({
  ...product,
  quantity: getCanonicalQuantity(product),
  sellPrice: Number(product.sellPrice ?? product.price ?? 0),
});

const toSaleDto = (sale) => ({
  ...sale,
  items: sale.items || [],
});

const getPaymentTotal = (sales, paymentMethod) =>
  sales
    .filter((sale) => sale.paymentMethod === paymentMethod)
    .reduce((acc, sale) => acc + Number(sale.total || 0) - Number(sale.returnedTotal || 0), 0);

const addActivityLog = (data, user, client = prisma) =>
  client.activityLog.create({
    data: {
      type: data.type || "general",
      title: data.title || "Amal bajarildi",
      description: data.description || "",
      userId: user?.id,
      userName: data.userName || user?.name || "Noma'lum foydalanuvchi",
      userRole: data.userRole || user?.role || "unknown",
      date: toUzDate(),
      time: toUzTime(),
    },
  });

const buildHistory = async () => {
  const days = await prisma.salesDay.findMany({
    orderBy: { dateISO: "desc" },
  });

  const sales = await prisma.sale.findMany({
    where: { status: "closed" },
    include: saleInclude,
    orderBy: { createdAt: "desc" },
  });

  return days.map((day) => ({
    ...day,
    sales: sales.filter((sale) => sale.dateISO === day.dateISO).map(toSaleDto),
  }));
};

router.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;

    const user = await prisma.user.findUnique({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Login yoki parol noto'g'ri" });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, env.jwtSecret, {
      expiresIn: "7d",
    });

    const { password: _, ...safeUser } = user;

    res.json({ token, user: safeUser });
  }),
);

router.get(
  "/auth/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(req.user);
  }),
);

router.use(requireAuth);

router.get(
  "/bootstrap",
  asyncHandler(async (req, res) => {
    const todayISO = toISODate();

    const [
      inventory,
      dailySales,
      suppliers,
      expenses,
      returns,
      activeShift,
      shiftHistory,
      activityLogs,
      telegramSettings,
    ] = await Promise.all([
      prisma.product.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.sale.findMany({
        where: { status: "active", dateISO: todayISO },
        include: saleInclude,
        orderBy: { createdAt: "desc" },
      }),
      prisma.supplier.findMany({
        include: { transactions: { orderBy: { createdAt: "desc" } } },
        orderBy: { createdAt: "desc" },
      }),
      prisma.expense.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.return.findMany({ orderBy: { createdAt: "desc" } }),
      prisma.shift.findFirst({ where: { status: "open" }, orderBy: { createdAt: "desc" } }),
      prisma.shift.findMany({ where: { status: "closed" }, orderBy: { closedAtISO: "desc" } }),
      prisma.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 500 }),
      getTelegramSettings(),
    ]);

    res.json({
      inventory: inventory.map(toProductDto),
      dailySales: dailySales.map(toSaleDto),
      salesHistory: await buildHistory(),
      suppliers: suppliers.map(toSupplierDto),
      expenses,
      returns,
      activeShift,
      shiftHistory,
      activityLogs,
      telegramSettings,
    });
  }),
);

router.get(
  "/products",
  asyncHandler(async (req, res) => {
    const products = await prisma.product.findMany({
      orderBy: { createdAt: "desc" },
    });

    res.json(products.map(toProductDto));
  }),
);

router.post(
  "/products",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const productInput = normalizeProductInput(req.body);

    const { product, supplier } = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          ...(req.body.id ? { id: String(req.body.id) } : {}),
          ...productInput,
        },
      });

      const supplier = await applySupplierDebtChange(tx, {
        supplierName: productInput.supplier,
        supplierPhone: productInput.supplierPhone,
        amount: isCreditPayment(productInput.paymentStatus)
          ? productInput.debtAmount
          : 0,
        productName: product.name,
        date: productInput.date,
        note: `${product.name} mahsuloti uchun qarz`,
      });

      await addActivityLog(
        {
          type: "product",
          title: "Yangi mahsulot qo'shildi",
          description: `${product.name} katalogga qo'shildi`,
        },
        req.user,
        tx,
      );

      if (supplier) {
        await addActivityLog(
          {
            type: "supplier",
            title: "Supplier qarzi qo'shildi",
            description: `${supplier.name} supplieriga ${productInput.debtAmount} qarz qo'shildi`,
          },
          req.user,
          tx,
        );
      }

      return { product, supplier };
    });

    if (product.quantity === 0) void sendTelegramEvent("outOfStock", product);
    if (product.quantity > 0 && product.quantity <= 5) void sendTelegramEvent("lowStock", product);

    res.status(201).json({ product: toProductDto(product), supplier: supplier ? toSupplierDto(supplier) : null });
  }),
);

router.put(
  "/products/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const productInput = normalizeProductInput(req.body);

    const { previous, product, supplier } = await prisma.$transaction(async (tx) => {
      const previous = await tx.product.findUnique({ where: { id: req.params.id } });

      if (!previous) {
        throw Object.assign(new Error("Mahsulot topilmadi"), { status: 404 });
      }

      const product = await tx.product.update({
        where: { id: req.params.id },
        data: productInput,
      });

      const supplier = await applySupplierDebtChange(tx, {
        supplierName: productInput.supplier,
        supplierPhone: productInput.supplierPhone,
        amount: getDebtAdjustment(previous, productInput),
        productName: product.name,
        date: productInput.date,
        note: `${product.name} qarz summasi yangilandi`,
      });

      await addActivityLog(
        {
          type: "product",
          title: "Mahsulot tahrirlandi",
          description: `${product.name} ma'lumotlari yangilandi`,
        },
        req.user,
        tx,
      );

      if (supplier) {
        await addActivityLog(
          {
            type: "supplier",
            title: "Supplier qarzi yangilandi",
            description: `${supplier.name} supplier qarzi yangilandi`,
          },
          req.user,
          tx,
        );
      }

      return { previous, product, supplier };
    });

    if (previous) void notifyStockChange(previous.quantity, product);

    res.json({ product: toProductDto(product), supplier: supplier ? toSupplierDto(supplier) : null });
  }),
);

router.delete(
  "/products/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const product = await prisma.product.delete({ where: { id: req.params.id } });

    await addActivityLog(
      {
        type: "product",
        title: "Mahsulot o'chirildi",
        description: `${product.name} katalogdan o'chirildi`,
      },
      req.user,
    );

    res.json(product);
  }),
);

router.put(
  "/products/bulk-sync",
  requireRole("admin", "cashier"),
  asyncHandler(async (req, res) => {
    const products = req.body.products || [];
    const productIds = products.map((item) => String(item.id));

    const saved = await prisma.$transaction(
      [
        prisma.product.deleteMany({
          where: {
            id: { notIn: productIds },
            saleItems: { none: {} },
          },
        }),
        ...products.map((item) =>
          prisma.product.upsert({
            where: { id: String(item.id) },
            create: {
              id: String(item.id),
              ...normalizeProductInput(item),
            },
            update: normalizeProductInput(item),
          }),
        ),
      ],
    );

    res.json(saved.slice(1).map(toProductDto));
  }),
);

router.get(
  "/sales/daily",
  asyncHandler(async (req, res) => {
    const sales = await prisma.sale.findMany({
      where: { status: "active", dateISO: toISODate() },
      include: saleInclude,
      orderBy: { createdAt: "desc" },
    });

    res.json(sales.map(toSaleDto));
  }),
);

router.post(
  "/sales",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const items = req.body.items || [];

    const sale = await prisma.$transaction(async (tx) => {
      const stockUpdates = [];

      for (const item of items) {
        const productId = String(item.productId || item.id);
        const requestedQty = Number(item.quantity || 0);
        const product = await tx.product.findUnique({
          where: { id: productId },
        });

        if (!product) {
          throw Object.assign(
            new Error(`${item.name || "Mahsulot"} topilmadi`),
            { status: 404 },
          );
        }

        const currentStock = getCanonicalQuantity(product);

        if (requestedQty <= 0 || currentStock < requestedQty) {
          throw Object.assign(
            new Error(
              `${product.name} uchun qoldiq yetarli emas. Omborda ${currentStock} dona bor`,
            ),
            { status: 400 },
          );
        }

        stockUpdates.push({
          product,
          productId,
          nextQuantity: currentStock - requestedQty,
          requestedQty,
        });
      }

      const createdSale = await tx.sale.create({
        data: {
          dateISO: req.body.dateISO || toISODate(now),
          date: req.body.date || toUzDate(now),
          time: req.body.time || toUzTime(now),
          total: Number(req.body.total || 0),
          returnedTotal: 0,
          paymentMethod: req.body.paymentMethod,
          sellerId: req.user.id,
          sellerName: req.user.name,
          sellerRole: req.user.role,
          items: {
            create: items.map((item) => ({
              productId: String(item.productId || item.id),
              name: item.name,
              sku: item.sku,
              quantity: Number(item.quantity || 0),
              price: Number(item.price || item.sellPrice || 0),
              costPrice: Number(item.costPrice || 0),
              returnedQty: 0,
              returnStatus: "none",
            })),
          },
        },
        include: saleInclude,
      });

      for (const stockUpdate of stockUpdates) {
        if (Number(stockUpdate.product.quantity || 0) !== getCanonicalQuantity(stockUpdate.product)) {
          await tx.product.update({
            where: { id: stockUpdate.productId },
            data: {
              quantity: getCanonicalQuantity(stockUpdate.product),
              stock: getCanonicalQuantity(stockUpdate.product),
            },
          });
        }

        const decrementResult = await tx.product.updateMany({
          where: {
            id: stockUpdate.productId,
            quantity: { gte: stockUpdate.requestedQty },
          },
          data: {
            quantity: { decrement: stockUpdate.requestedQty },
            stock: { decrement: stockUpdate.requestedQty },
          },
        });

        if (decrementResult.count !== 1) {
          throw Object.assign(
            new Error(`${stockUpdate.product.name} uchun qoldiq yetarli emas`),
            { status: 400 },
          );
        }

        const updated = await tx.product.findUnique({
          where: { id: stockUpdate.productId },
        });

        void notifyStockChange(
          getCanonicalQuantity(stockUpdate.product),
          toProductDto(updated),
        );
      }

      return createdSale;
    });

    await addActivityLog(
      {
        type: "sale",
        title: "Savdo amalga oshirildi",
        description: `${sale.items.length} turdagi mahsulot sotildi`,
      },
      req.user,
    );

    void notifyNewSale(toSaleDto(sale));

    res.status(201).json(toSaleDto(sale));
  }),
);

router.post(
  "/sales/close-day",
  asyncHandler(async (req, res) => {
    const dateISO = req.body.dateISO || toISODate();
    const sales = await prisma.sale.findMany({
      where: { status: "active", dateISO },
      include: saleInclude,
    });

    const total = sales.reduce((acc, sale) => acc + Number(sale.total || 0) - Number(sale.returnedTotal || 0), 0);
    const returnedTotal = sales.reduce((acc, sale) => acc + Number(sale.returnedTotal || 0), 0);

    const report = await prisma.salesDay.upsert({
      where: { dateISO },
      create: {
        dateISO,
        date: req.body.date || toUzDate(),
        total,
        cash: getPaymentTotal(sales, "cash"),
        card: getPaymentTotal(sales, "card"),
        transfer: getPaymentTotal(sales, "transfer"),
        returnedTotal,
        count: sales.length,
        closedBy: req.user.name,
      },
      update: {
        total: { increment: total },
        cash: { increment: getPaymentTotal(sales, "cash") },
        card: { increment: getPaymentTotal(sales, "card") },
        transfer: { increment: getPaymentTotal(sales, "transfer") },
        returnedTotal: { increment: returnedTotal },
        count: { increment: sales.length },
        closedBy: req.user.name,
      },
    });

    await prisma.sale.updateMany({
      where: { status: "active", dateISO },
      data: { status: "closed" },
    });

    void notifyDailyReport(report);

    res.json({ report, dailySales: [] });
  }),
);

router.get(
  "/sales/history",
  asyncHandler(async (req, res) => {
    res.json(await buildHistory());
  }),
);

router.post(
  "/returns",
  asyncHandler(async (req, res) => {
    const { saleId, productId, quantity, reason } = req.body;
    const qty = Number(quantity || req.body.returnedQty || 0);

    const result = await prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({
        where: { id: saleId },
        include: { items: true },
      });

      const saleItem =
        sale?.items.find((item) => item.productId === String(productId)) ||
        sale?.items.find((item) => item.id === req.body.saleItemId);

      if (!sale || !saleItem) {
        throw Object.assign(new Error("Savdo yoki mahsulot topilmadi"), { status: 404 });
      }

      const available = saleItem.quantity - saleItem.returnedQty;
      const returnQty = Math.min(qty, available);

      if (returnQty <= 0) {
        throw Object.assign(new Error("Qaytarish mumkin bo'lgan miqdor yo'q"), { status: 400 });
      }

      const amount = returnQty * Number(saleItem.price || 0);

      const returnItem = await tx.return.create({
        data: {
          saleId: sale.id,
          saleItemId: saleItem.id,
          productId: saleItem.productId,
          productName: saleItem.name,
          sku: saleItem.sku,
          quantity: returnQty,
          amount,
          reason,
          paymentMethod: sale.paymentMethod,
          sellerId: req.user.id,
          sellerName: req.user.name,
          sellerRole: req.user.role,
          date: toUzDate(),
          dateISO: toISODate(),
          time: toUzTime(),
        },
      });

      await tx.saleItem.update({
        where: { id: saleItem.id },
        data: {
          returnedQty: { increment: returnQty },
          returnStatus: returnQty === available ? "full" : "partial",
        },
      });

      await tx.sale.update({
        where: { id: sale.id },
        data: { returnedTotal: { increment: amount } },
      });

      await tx.product.update({
        where: { id: saleItem.productId },
        data: {
          quantity: { increment: returnQty },
          stock: { increment: returnQty },
        },
      });

      return returnItem;
    });

    await addActivityLog(
      {
        type: "return",
        title: "Vozvrat qilindi",
        description: `${result.productName} vozvrat qilindi: ${result.quantity} dona`,
      },
      req.user,
    );

    void notifyReturn(result);

    res.status(201).json(result);
  }),
);

router.get(
  "/returns",
  asyncHandler(async (req, res) => {
    res.json(await prisma.return.findMany({ orderBy: { createdAt: "desc" } }));
  }),
);

router.get(
  "/suppliers",
  asyncHandler(async (req, res) => {
    const suppliers = await prisma.supplier.findMany({
      include: { transactions: { orderBy: { createdAt: "desc" } } },
      orderBy: { createdAt: "desc" },
    });

    res.json(suppliers.map(toSupplierDto));
  }),
);

router.post(
  "/suppliers",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const input = normalizeSupplierInput(req.body);

    if (!input.name.trim()) {
      return res.status(400).json({ message: "Supplier nomi kiritilishi kerak" });
    }

    const supplier = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.create({
        data: {
          ...(req.body.id ? { id: String(req.body.id) } : {}),
          ...input,
          transactions:
            input.debt > 0
              ? {
                  create: {
                    type: "inventory",
                    status: "Qarz",
                    amount: input.debt,
                    phone: input.phone,
                    date: input.deadline || toUzDate(),
                    time: toUzTime(),
                    note: "Boshlang'ich qarz",
                  },
                }
              : undefined,
        },
        include: { transactions: { orderBy: { createdAt: "desc" } } },
      });

      await addActivityLog(
        { type: "supplier", title: "Supplier qo'shildi", description: supplier.name },
        req.user,
        tx,
      );

      return supplier;
    });

    res.status(201).json(toSupplierDto(supplier));
  }),
);

router.put(
  "/suppliers/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const supplier = await prisma.supplier.update({
      where: { id: req.params.id },
      data: normalizeSupplierInput(req.body),
      include: { transactions: { orderBy: { createdAt: "desc" } } },
    });

    res.json(toSupplierDto(supplier));
  }),
);

router.delete(
  "/suppliers/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(await prisma.supplier.delete({ where: { id: req.params.id } }));
  }),
);

router.post(
  "/suppliers/:id/transactions",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const transaction = await prisma.supplierTransaction.create({
      data: {
        supplierId: req.params.id,
        type: req.body.type || "payment",
        status: req.body.status,
        productName: req.body.productName,
        amount: Number(req.body.amount || 0),
        phone: req.body.phone,
        date: req.body.date || toUzDate(),
        time: req.body.time || toUzTime(),
        note: req.body.note,
      },
    });

    res.status(201).json(transaction);
  }),
);

router.post(
  "/suppliers/:id/payments",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const amount = Number(req.body.amount || 0);

    if (amount <= 0) {
      return res.status(400).json({ message: "To'lov summasi noto'g'ri" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.supplier.findUnique({ where: { id: req.params.id } });

      if (!current) {
        throw Object.assign(new Error("Supplier topilmadi"), { status: 404 });
      }

      const balance = Number(current.debt || 0) - Number(current.paid || 0);

      if (amount > balance) {
        throw Object.assign(new Error("To'lov summasi qoldiq qarzdan katta"), {
          status: 400,
        });
      }

      const supplier = await tx.supplier.update({
        where: { id: req.params.id },
        data: { paid: { increment: amount } },
        include: { transactions: { orderBy: { createdAt: "desc" } } },
      });

      const transaction = await tx.supplierTransaction.create({
        data: {
          supplierId: req.params.id,
          type: "payment",
          status: "To'lov",
          amount,
          date: req.body.date || toUzDate(),
          time: req.body.time || toUzTime(),
          note: req.body.note,
        },
      });

      return { supplier: toSupplierDto(supplier), transaction };
    });

    await addActivityLog(
      {
        type: "supplier",
        title: "Supplier to'lovi qilindi",
        description: `${result.supplier.name} supplieriga to'lov qilindi`,
      },
      req.user,
    );

    res.status(201).json(result);
  }),
);

router.get(
  "/expenses",
  asyncHandler(async (req, res) => {
    res.json(await prisma.expense.findMany({ orderBy: { createdAt: "desc" } }));
  }),
);

router.post(
  "/expenses",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.status(201).json(
      await prisma.expense.create({
        data: {
          ...req.body,
          amount: Number(req.body.amount || 0),
          date: req.body.date || toUzDate(),
        },
      }),
    );
  }),
);

router.delete(
  "/expenses/:id",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(await prisma.expense.delete({ where: { id: req.params.id } }));
  }),
);

router.get(
  "/shifts/active",
  asyncHandler(async (req, res) => {
    res.json(await prisma.shift.findFirst({ where: { status: "open" }, orderBy: { createdAt: "desc" } }));
  }),
);

router.get(
  "/shifts",
  asyncHandler(async (req, res) => {
    res.json(await prisma.shift.findMany({ orderBy: { createdAt: "desc" } }));
  }),
);

router.post(
  "/shifts/open",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const shift = await prisma.shift.create({
      data: {
        cashierName: req.body.cashierName,
        openedById: req.user.id,
        openedByName: req.user.name,
        openingCash: Number(req.body.openingCash || 0),
        openedAt: toUzTime(now),
        openedAtISO: now,
        date: toUzDate(now),
        status: "open",
      },
    });

    await addActivityLog({ type: "shift", title: "Shift ochildi", description: shift.cashierName }, req.user);
    void notifyShiftOpen(shift);

    res.status(201).json(shift);
  }),
);

router.post(
  "/shifts/:id/close",
  asyncHandler(async (req, res) => {
    const shift = await prisma.shift.findUnique({ where: { id: req.params.id } });
    if (!shift) return res.status(404).json({ message: "Shift topilmadi" });

    const sales = await prisma.sale.findMany({ where: { status: "active", dateISO: toISODate() } });
    const now = new Date();
    const cashSales = getPaymentTotal(sales, "cash");
    const closedShift = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        closedById: req.user.id,
        closedByName: req.user.name,
        closingCash: Number(req.body.closingCash || 0),
        totalSales: sales.reduce((acc, sale) => acc + Number(sale.total || 0), 0),
        cashSales,
        cardSales: getPaymentTotal(sales, "card"),
        transferSales: getPaymentTotal(sales, "transfer"),
        transactions: sales.length,
        cashDifference: Number(req.body.closingCash || 0) - (Number(shift.openingCash || 0) + cashSales),
        closedAt: toUzTime(now),
        closedAtISO: now,
        duration: formatDuration(shift.openedAtISO, now),
        status: "closed",
      },
    });

    await addActivityLog({ type: "shift", title: "Shift yopildi", description: closedShift.cashierName }, req.user);
    void notifyShiftClose(closedShift);

    res.json(closedShift);
  }),
);

router.get(
  "/activity-logs",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(await prisma.activityLog.findMany({ orderBy: { createdAt: "desc" }, take: 500 }));
  }),
);

router.post(
  "/activity-logs",
  asyncHandler(async (req, res) => {
    res.status(201).json(await addActivityLog(req.body, req.user));
  }),
);

router.get(
  "/dashboard/summary",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const [inventory, dailySales, salesHistory, expenses, returns, suppliers] = await Promise.all([
      prisma.product.findMany(),
      prisma.sale.findMany({ where: { status: "active", dateISO: toISODate() }, include: saleInclude }),
      buildHistory(),
      prisma.expense.findMany(),
      prisma.return.findMany(),
      prisma.supplier.findMany(),
    ]);

    res.json({ inventory, dailySales, salesHistory, expenses, returns, suppliers });
  }),
);

router.get(
  "/telegram/settings",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(await getTelegramSettings());
  }),
);

router.put(
  "/telegram/settings",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(await updateTelegramSettings(req.body));
  }),
);

router.post(
  "/telegram/test",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(
      await sendTelegramMessage(
        "✅ <b>TECHPRO Telegram test</b>\n\nTelegram bot muvaffaqiyatli ulandi.",
      ),
    );
  }),
);

router.post(
  "/telegram/events/:type",
  asyncHandler(async (req, res) => {
    res.json(await sendTelegramEvent(req.params.type, req.body));
  }),
);

export default router;
