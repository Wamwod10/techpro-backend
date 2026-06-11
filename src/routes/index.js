import { Router } from "express";
import { prisma } from "../config/prisma.js";
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

const activeProductWhere = {
  isDeleted: false,
};

const DEFAULT_STORE_ID = "dokon-1";
const DEFAULT_STORES = [
  { id: "dokon-1", name: "dokon-1" },
  { id: "dokon-2", name: "dokon-2" },
];
const LOW_STOCK_THRESHOLD = 3;

const isAdminUser = (user) => user?.role === "admin";

const normalizeRole = (role) => (role === "admin" ? "admin" : "cashier");

const getRequestUser = (req) => ({
  id: null,
  username:
    req.headers["x-techpro-username"] ||
    req.body?.username ||
    req.body?.sellerUsername ||
    null,
  name:
    req.headers["x-techpro-user-name"] ||
    req.body?.userName ||
    req.body?.sellerName ||
    req.body?.openedByName ||
    req.body?.closedBy ||
    "Noma'lum foydalanuvchi",
  role: normalizeRole(
    req.headers["x-techpro-user-role"] ||
      req.body?.userRole ||
      req.body?.sellerRole,
  ),
});

let defaultStoresPromise;

const ensureDefaultStores = () => {
  if (!defaultStoresPromise) {
    defaultStoresPromise = Promise.all(
      DEFAULT_STORES.map((store) =>
        prisma.store.upsert({
          where: { id: store.id },
          update: { name: store.name },
          create: store,
        }),
      ),
    );
  }

  return defaultStoresPromise;
};

const getRequestedStoreId = (req) =>
  req.headers["x-techpro-store-id"] ||
  req.query.storeId ||
  req.body?.storeId ||
  null;

const attachRequestUser = async (req, res, next) => {
  const requestUser = getRequestUser(req);

  try {
    await ensureDefaultStores();

    const dbUser = requestUser.username
      ? await prisma.user.findUnique({
          where: { username: requestUser.username },
          select: { id: true, name: true, username: true, role: true, storeId: true },
        })
      : null;

    const user = {
      ...requestUser,
      ...dbUser,
      role: normalizeRole(dbUser?.role || requestUser.role),
    };

    let storeId = user.storeId || DEFAULT_STORE_ID;

    if (isAdminUser(user)) {
      storeId = getRequestedStoreId(req) || DEFAULT_STORE_ID;

      const storeExists = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true },
      });

      if (!storeExists) {
        throw Object.assign(new Error("Do'kon topilmadi"), { status: 400 });
      }
    }

    req.user = user;
    req.storeId = storeId;
    next();
  } catch (error) {
    next(error);
  }
};

const getStoreWhere = (req, extra = {}) => ({
  ...extra,
  storeId: req.storeId,
});

const getActiveProductWhere = (req, extra = {}) =>
  getStoreWhere(req, { ...activeProductWhere, ...extra });

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

const validateProductInput = (input) => {
  if (!String(input.name || "").trim()) {
    throw Object.assign(new Error("Mahsulot nomi kiritilishi kerak"), {
      status: 400,
    });
  }

  if (Number(input.sellPrice || 0) < 0 || Number(input.costPrice || 0) < 0) {
    throw Object.assign(new Error("Mahsulot narxi noto'g'ri"), {
      status: 400,
    });
  }

  if (Number(input.quantity || 0) < 0) {
    throw Object.assign(new Error("Mahsulot soni manfiy bo'lishi mumkin emas"), {
      status: 400,
    });
  }
};

const normalizeSupplierInput = (data) => ({
  name: String(data.name || data.supplierName || "").trim(),
  phone: data.phone || data.supplierPhone || null,
  address: data.address || null,
  notes: data.notes || data.comment || null,
  debt: Number(data.debt ?? data.totalDebt ?? 0),
  paid: Number(data.paid ?? data.paidAmount ?? 0),
  deadline: data.deadline || data.date || null,
});

const validateSupplierInput = (input) => {
  if (!input.name) {
    throw Object.assign(new Error("Supplier nomi kiritilishi kerak"), {
      status: 400,
    });
  }

  if (
    Number.isNaN(input.debt) ||
    Number.isNaN(input.paid) ||
    input.debt < 0 ||
    input.paid < 0
  ) {
    throw Object.assign(new Error("Supplier summalari manfiy bo'lishi mumkin emas"), {
      status: 400,
    });
  }
};

const toSupplierDto = (supplier) => ({
  ...supplier,
  orders: supplier.transactions || [],
});

const findSupplierByName = (client, name, storeId) =>
  client.supplier.findFirst({
    where: {
      storeId,
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
    include: { transactions: { orderBy: { createdAt: "desc" } } },
  });

const applySupplierDebtChange = async (
  client,
  { storeId, supplierName, supplierPhone, amount, productName, date, note },
) => {
  const cleanSupplierName = String(supplierName || "").trim();
  const debtAmount = Number(amount || 0);

  if (!cleanSupplierName || debtAmount === 0) {
    return null;
  }

  const existingSupplier = await findSupplierByName(client, cleanSupplierName, storeId);
  const transactionStatus = debtAmount > 0 ? "Qarz" : "Tuzatish";

  if (!existingSupplier) {
    const supplier = await client.supplier.create({
      data: {
        storeId,
        name: cleanSupplierName,
        phone: supplierPhone || null,
        debt: Math.max(0, debtAmount),
        paid: 0,
        deadline: date || null,
        transactions: {
          create: {
            type: debtAmount > 0 ? "inventory" : "adjustment",
            storeId,
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
          storeId,
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

const toProductDto = (product, { includeSensitive = true } = {}) => {
  const dto = {
    ...product,
    quantity: getCanonicalQuantity(product),
    sellPrice: Number(product.sellPrice ?? product.price ?? 0),
  };

  if (!includeSensitive) {
    delete dto.costPrice;
    delete dto.supplier;
    delete dto.paymentStatus;
    delete dto.debtAmount;
    delete dto.supplierPhone;
    delete dto.returnDays;
    delete dto.date;
  }

  return dto;
};

const roundMoney = (value) => Math.round(Number(value || 0) * 100) / 100;

const getItemOriginalPrice = (item) =>
  Number(item?.originalPrice ?? item?.price ?? item?.sellPrice ?? 0);

const getItemFinalPrice = (item) =>
  Number(item?.finalPrice ?? item?.price ?? item?.sellPrice ?? 0);

const normalizeSalePricing = (sale) => {
  const items = (sale.items || []).map((item) => {
    const originalPrice = getItemOriginalPrice(item);
    const finalPrice = getItemFinalPrice(item);

    return {
      ...item,
      price: finalPrice,
      originalPrice,
      finalPrice,
      itemDiscountPercent: Number(item.itemDiscountPercent || 0),
      itemDiscountAmount: Number(item.itemDiscountAmount || 0),
    };
  });

  const saleSubtotal = roundMoney(
    items.reduce(
      (acc, item) => acc + Number(item.originalPrice || 0) * Number(item.quantity || 0),
      0,
    ) || sale.saleSubtotal || sale.total || 0,
  );
  const saleDiscountTotal = roundMoney(
    items.reduce(
      (acc, item) =>
        acc +
        Math.max(0, Number(item.originalPrice || 0) - Number(item.finalPrice || 0)) *
          Number(item.quantity || 0),
      0,
    ) || sale.saleDiscountTotal || 0,
  );
  const saleTotal = roundMoney(
    Number(sale.saleTotal || 0) > 0
      ? sale.saleTotal
      : sale.total || saleSubtotal - saleDiscountTotal,
  );

  return {
    ...sale,
    items,
    saleSubtotal,
    saleDiscountTotal,
    saleTotal,
    total: Number(sale.total ?? saleTotal),
  };
};

const toSaleDto = (sale, { includeSensitive = true } = {}) => {
  const normalizedSale = normalizeSalePricing(sale);

  return {
    ...normalizedSale,
    items: normalizedSale.items.map((item) => {
      if (includeSensitive) return item;

      const { costPrice, ...safeItem } = item;
      return safeItem;
    }),
  };
};

const calculateSaleItemPricing = (item, product) => {
  const originalPrice = roundMoney(product.sellPrice ?? product.price ?? item.originalPrice ?? item.price ?? 0);
  const percent = Math.min(
    100,
    Math.max(0, Number(item.itemDiscountPercent || 0)),
  );
  const amount = Math.max(0, Number(item.itemDiscountAmount || 0));
  const percentDiscount = roundMoney((originalPrice * percent) / 100);
  const discountPerUnit = Math.min(originalPrice, roundMoney(percentDiscount + amount));
  const finalPrice = roundMoney(originalPrice - discountPerUnit);

  return {
    originalPrice,
    finalPrice,
    itemDiscountPercent: percent,
    itemDiscountAmount: roundMoney(amount),
    discountPerUnit,
    discountTotal: roundMoney(discountPerUnit * Number(item.quantity || 0)),
  };
};

const getSaleGrossTotal = (sale) =>
  Math.max(
    0,
    (Number(sale.saleTotal || 0) > 0
      ? Number(sale.saleTotal || 0)
      : Number(sale.total || 0)) - Number(sale.returnedTotal || 0),
  );

const getPaymentTotal = (sales, paymentMethod) =>
  sales
    .filter((sale) => sale.paymentMethod === paymentMethod)
    .reduce((acc, sale) => acc + getSaleGrossTotal(sale), 0);

const summarizeSales = (sales = []) => ({
  totalSales: roundMoney(
    sales.reduce((acc, sale) => acc + getSaleGrossTotal(sale), 0),
  ),
  cashSales: roundMoney(getPaymentTotal(sales, "cash")),
  cardSales: roundMoney(getPaymentTotal(sales, "card")),
  transferSales: roundMoney(getPaymentTotal(sales, "transfer")),
  transactions: sales.length,
});

const getShiftSalesWhere = (shift, closedAtISO) => ({
  storeId: shift.storeId,
  OR: [
    { shiftId: shift.id },
    {
      shiftId: null,
      createdAt: {
        gte: shift.openedAtISO,
        lte: closedAtISO,
      },
    },
  ],
});

const generateQuickSku = (index) =>
  `TP-${Date.now().toString(36).toUpperCase()}-${String(index + 1).padStart(3, "0")}`;

const normalizeQuickEntry = (data) => {
  const rows = Array.isArray(data.items) ? data.items : [];
  const paymentStatus = normalizePaymentStatus(data.paymentStatus);

  return {
    supplierName: String(data.supplier || data.supplierName || "").trim(),
    supplierPhone: data.supplierPhone || "",
    date: data.date || toISODate(),
    paymentStatus,
    items: rows
      .map((item, index) => {
        const quantity = Math.max(0, Math.floor(Number(item.quantity || 0)));
        const costPrice = Number(item.costPrice || 0);
        const sellPrice = Number(item.sellPrice ?? item.price ?? 0);

        return {
          name: String(item.name || "").trim(),
          sku: String(item.sku || "").trim() || generateQuickSku(index),
          category: String(item.category || "Boshqa").trim() || "Boshqa",
          quantity,
          stock: quantity,
          costPrice,
          sellPrice,
          price: sellPrice,
          supplier: String(data.supplier || data.supplierName || "").trim(),
          supplierPhone: data.supplierPhone || "",
          paymentStatus,
          debtAmount: isCreditPayment(paymentStatus) ? quantity * costPrice : 0,
          date: data.date || toISODate(),
          duplicateAction: item.duplicateAction === "new" ? "new" : "merge",
        };
      })
      .filter((item) => item.name && item.quantity > 0),
  };
};

const addActivityLog = async (data, user, client = prisma, storeId = DEFAULT_STORE_ID) => {
  const logData = {
    storeId,
    type: data.type || "general",
    title: data.title || "Amal bajarildi",
    description: data.description || "",
    userId: user?.id,
    userName: user?.name || "Noma'lum foydalanuvchi",
    userRole: user?.role || "unknown",
    date: toUzDate(),
    time: toUzTime(),
  };

  const duplicate = await client.activityLog.findFirst({
    where: {
      storeId: logData.storeId,
      type: logData.type,
      title: logData.title,
      description: logData.description,
      userId: logData.userId,
      createdAt: {
        gte: new Date(Date.now() - 8000),
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (duplicate) {
    return duplicate;
  }

  return client.activityLog.create({
    data: {
      ...logData,
    },
  });
};

const buildHistory = async ({ storeId, includeSensitive = true } = {}) => {
  const days = await prisma.salesDay.findMany({
    where: { storeId },
    orderBy: { dateISO: "desc" },
  });

  if (!days.length) {
    return [];
  }

  const sales = await prisma.sale.findMany({
    where: {
      storeId,
      status: "closed",
      dateISO: { in: days.map((day) => day.dateISO) },
    },
    include: saleInclude,
    orderBy: { createdAt: "desc" },
  });
  const salesByDate = new Map();

  for (const sale of sales) {
    const dateSales = salesByDate.get(sale.dateISO) || [];
    dateSales.push(toSaleDto(sale, { includeSensitive }));
    salesByDate.set(sale.dateISO, dateSales);
  }

  return days.map((day) => ({
    ...day,
    sales: salesByDate.get(day.dateISO) || [],
  }));
};

router.use(attachRequestUser);

router.get(
  "/bootstrap",
  asyncHandler(async (req, res) => {
    const todayISO = toISODate();
    const includeHistory = req.query.includeHistory === "true";
    const includeBackground = req.query.includeBackground !== "false";
    const includeSensitive = isAdminUser(req.user);
    const stores = await prisma.store.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true },
    });

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
      prisma.product.findMany({
        where: getActiveProductWhere(req),
        orderBy: { createdAt: "desc" },
      }),
      prisma.sale.findMany({
        where: getStoreWhere(req, { status: "active", dateISO: todayISO }),
        include: saleInclude,
        orderBy: { createdAt: "desc" },
      }),
      includeSensitive && includeBackground
        ? prisma.supplier.findMany({
            where: getStoreWhere(req),
            include: { transactions: { orderBy: { createdAt: "desc" } } },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      includeSensitive && includeBackground
        ? prisma.expense.findMany({ where: getStoreWhere(req), orderBy: { createdAt: "desc" } })
        : Promise.resolve([]),
      includeBackground
        ? prisma.return.findMany({ where: getStoreWhere(req), orderBy: { createdAt: "desc" } })
        : Promise.resolve([]),
      prisma.shift.findFirst({ where: getStoreWhere(req, { status: "open" }), orderBy: { createdAt: "desc" } }),
      includeBackground
        ? prisma.shift.findMany({ where: getStoreWhere(req, { status: "closed" }), orderBy: { closedAtISO: "desc" } })
        : Promise.resolve([]),
      includeSensitive && includeBackground
        ? prisma.activityLog.findMany({ where: getStoreWhere(req), orderBy: { createdAt: "desc" }, take: 500 })
        : Promise.resolve([]),
      includeSensitive && includeBackground ? getTelegramSettings(req.storeId) : Promise.resolve(null),
    ]);

    res.json({
      stores,
      currentStoreId: req.storeId,
      inventory: inventory.map((product) =>
        toProductDto(product, { includeSensitive }),
      ),
      dailySales: dailySales.map((sale) =>
        toSaleDto(sale, { includeSensitive }),
      ),
      salesHistory: includeHistory
        ? await buildHistory({ storeId: req.storeId, includeSensitive })
        : [],
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
    const includeSensitive = isAdminUser(req.user);
    const products = await prisma.product.findMany({
      where: getActiveProductWhere(req),
      orderBy: { createdAt: "desc" },
    });

    res.json(
      products.map((product) => toProductDto(product, { includeSensitive })),
    );
  }),
);

router.post(
  "/products",
  asyncHandler(async (req, res) => {
    const productInput = normalizeProductInput(req.body);
    validateProductInput(productInput);

    const { product, supplier } = await prisma.$transaction(async (tx) => {
      const reviveFilters = [
        req.body.id ? { id: String(req.body.id) } : null,
        productInput.sku ? { sku: productInput.sku } : null,
        productInput.barcode ? { barcode: productInput.barcode } : null,
      ].filter(Boolean);

      const deletedProduct = reviveFilters.length
        ? await tx.product.findFirst({
            where: {
              storeId: req.storeId,
              isDeleted: true,
              OR: reviveFilters,
            },
          })
        : null;

      const product = deletedProduct
        ? await tx.product.update({
            where: { id: deletedProduct.id },
            data: {
              ...productInput,
              isDeleted: false,
              deletedAt: null,
            },
          })
        : await tx.product.create({
            data: {
              ...(req.body.id ? { id: String(req.body.id) } : {}),
              storeId: req.storeId,
              ...productInput,
            },
          });

      const supplier = await applySupplierDebtChange(tx, {
        storeId: req.storeId,
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
        req.storeId,
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
          req.storeId,
        );
      }

      return { product, supplier };
    });

    if (product.quantity === 0) void sendTelegramEvent("outOfStock", product, req.storeId);
    if (product.quantity > 0 && product.quantity <= LOW_STOCK_THRESHOLD) {
      void sendTelegramEvent("lowStock", product, req.storeId);
    }

    res.status(201).json({ product: toProductDto(product), supplier: supplier ? toSupplierDto(supplier) : null });
  }),
);

router.post(
  "/inventory/quick-entry",
  asyncHandler(async (req, res) => {
    const entry = normalizeQuickEntry(req.body);

    if (!entry.items.length) {
      return res.status(400).json({ message: "Kamida bitta mahsulot kiriting" });
    }

    if (!entry.supplierName) {
      return res.status(400).json({ message: "Ta'minotchi kiritilishi kerak" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const products = [];
      const suppliers = [];
      const warnings = [];
      const totalDebt = entry.items.reduce(
        (acc, item) => acc + Number(item.debtAmount || 0),
        0,
      );

      for (const item of entry.items) {
        validateProductInput(item);

        const existingByName = await tx.product.findFirst({
          where: {
            ...getActiveProductWhere(req),
            name: {
              equals: item.name,
              mode: "insensitive",
            },
          },
        });
        const existingBySku = item.sku
          ? await tx.product.findFirst({
              where: {
                ...getActiveProductWhere(req),
                sku: item.sku,
              },
            })
          : null;
        const existingProduct = existingByName || existingBySku;

        const shouldMerge = existingProduct && item.duplicateAction !== "new";

        if (shouldMerge) {
          const product = await tx.product.update({
            where: { id: existingProduct.id },
            data: {
              quantity: { increment: item.quantity },
              stock: { increment: item.quantity },
              category: item.category || existingProduct.category,
              costPrice: item.costPrice,
              sellPrice: item.sellPrice,
              price: item.sellPrice,
              supplier: entry.supplierName,
              supplierPhone: entry.supplierPhone,
              paymentStatus: item.paymentStatus,
              date: entry.date,
            },
          });

          products.push(product);
          warnings.push({
            productId: product.id,
            name: product.name,
            action: "merged",
          });
          continue;
        }

        const product = await tx.product.create({
          data: {
            storeId: req.storeId,
            name: item.name,
            sku: item.sku,
            category: item.category,
            quantity: item.quantity,
            stock: item.quantity,
            costPrice: item.costPrice,
            sellPrice: item.sellPrice,
            price: item.sellPrice,
            supplier: entry.supplierName,
            supplierPhone: entry.supplierPhone,
            paymentStatus: item.paymentStatus,
            debtAmount: item.debtAmount,
            date: entry.date,
          },
        });

        products.push(product);

        if (existingByName) {
          warnings.push({
            productId: product.id,
            existingProductId: existingByName.id,
            name: product.name,
            action: "created_new_sku",
          });
        }
      }

      const supplier =
        totalDebt > 0
          ? await applySupplierDebtChange(tx, {
              storeId: req.storeId,
              supplierName: entry.supplierName,
              supplierPhone: entry.supplierPhone,
              amount: totalDebt,
              productName: "Tezkor kirim",
              date: entry.date,
              note: `${entry.items.length} turdagi mahsulot uchun supplier qarzi`,
            })
          : null;

      if (supplier) suppliers.push(supplier);

      await addActivityLog(
        {
          type: "inventory",
          title: "Tezkor kirim qilindi",
          description: `${products.length} turdagi mahsulot kirim qilindi`,
        },
        req.user,
        tx,
        req.storeId,
      );

      if (supplier) {
        await addActivityLog(
          {
            type: "supplier",
            title: "Supplier qarzi qo'shildi",
            description: `${supplier.name} supplieriga ${totalDebt} qarz qo'shildi`,
          },
          req.user,
          tx,
          req.storeId,
        );
      }

      return { products, suppliers, warnings };
    });

    for (const product of result.products) {
      if (product.quantity === 0) void sendTelegramEvent("outOfStock", product, req.storeId);
      if (product.quantity > 0 && product.quantity <= LOW_STOCK_THRESHOLD) {
        void sendTelegramEvent("lowStock", product, req.storeId);
      }
    }

    res.status(201).json({
      products: result.products.map(toProductDto),
      suppliers: result.suppliers.map(toSupplierDto),
      warnings: result.warnings,
    });
  }),
);

router.put(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const productInput = normalizeProductInput(req.body);
    validateProductInput(productInput);

    const { previous, product, supplier } = await prisma.$transaction(async (tx) => {
      const previous = await tx.product.findFirst({
        where: getActiveProductWhere(req, { id: req.params.id }),
      });

      if (!previous) {
        throw Object.assign(new Error("Mahsulot topilmadi"), { status: 404 });
      }

      const product = await tx.product.update({
        where: { id: req.params.id },
        data: productInput,
      });

      const supplier = await applySupplierDebtChange(tx, {
        storeId: req.storeId,
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
        req.storeId,
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
          req.storeId,
        );
      }

      return { previous, product, supplier };
    });

    if (previous) void notifyStockChange(previous.quantity, product, req.storeId);

    res.json({ product: toProductDto(product), supplier: supplier ? toSupplierDto(supplier) : null });
  }),
);

router.delete(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const existing = await prisma.product.findFirst({
      where: getActiveProductWhere(req, { id: req.params.id }),
    });

    if (!existing) {
      throw Object.assign(new Error("Mahsulot topilmadi"), { status: 404 });
    }

    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
      },
    });

    await addActivityLog(
      {
        type: "product",
        title: "Mahsulot o'chirildi",
        description: `${product.name} katalogdan o'chirildi`,
      },
      req.user,
      prisma,
      req.storeId,
    );

    res.json(toProductDto(product));
  }),
);

router.put(
  "/products/bulk-sync",
  asyncHandler(async (req, res) => {
    const products = req.body.products || [];
    const productIds = products.map((item) => String(item.id));

    if (!products.length) {
      return res.json([]);
    }

    const foreignProductsCount = await prisma.product.count({
      where: {
        id: { in: productIds },
        storeId: { not: req.storeId },
      },
    });

    if (foreignProductsCount > 0) {
      return res.status(403).json({ message: "Boshqa do'kon mahsulotlarini sync qilish mumkin emas" });
    }

    const syncOperations = [
      ...products.map((item) =>
        prisma.product.upsert({
          where: { id: String(item.id) },
          create: {
            id: String(item.id),
            storeId: req.storeId,
            ...normalizeProductInput(item),
            isDeleted: false,
            deletedAt: null,
          },
          update: {
            ...normalizeProductInput(item),
            isDeleted: false,
            deletedAt: null,
          },
        }),
      ),
    ];

    syncOperations.unshift(
      prisma.product.updateMany({
        where: {
          storeId: req.storeId,
          id: { notIn: productIds },
          isDeleted: false,
        },
        data: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      }),
    );

    const saved = await prisma.$transaction(syncOperations);
    const syncedProducts = saved.slice(1);

    res.json(syncedProducts.map(toProductDto));
  }),
);

router.get(
  "/sales/daily",
  asyncHandler(async (req, res) => {
    const includeSensitive = isAdminUser(req.user);
    const sales = await prisma.sale.findMany({
      where: getStoreWhere(req, { status: "active", dateISO: toISODate() }),
      include: saleInclude,
      orderBy: { createdAt: "desc" },
    });

    res.json(sales.map((sale) => toSaleDto(sale, { includeSensitive })));
  }),
);

router.post(
  "/sales",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const items = req.body.items || [];
    const openShift = await prisma.shift.findFirst({
      where: getStoreWhere(req, { status: "open" }),
      select: { id: true },
    });

    if (!items.length) {
      return res.status(400).json({ message: "Savat bo'sh" });
    }

    if (!openShift) {
      return res.status(400).json({ message: "Avval kassani oching" });
    }

    if (!["cash", "card", "transfer"].includes(req.body.paymentMethod)) {
      return res.status(400).json({ message: "To'lov turi noto'g'ri" });
    }

    const sale = await prisma.$transaction(async (tx) => {
      const stockUpdates = [];
      const saleItems = [];

      for (const item of items) {
        const productId = String(item.productId || item.id);
        const requestedQty = Number(item.quantity || 0);
        const product = await tx.product.findFirst({
          where: getActiveProductWhere(req, { id: productId }),
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

        const pricing = calculateSaleItemPricing(
          { ...item, quantity: requestedQty },
          product,
        );
        const costPrice = Number(product.costPrice || 0);

        if (pricing.finalPrice < costPrice && !isAdminUser(req.user)) {
          throw Object.assign(
            new Error(
              `${product.name} tannarxdan past sotilishi mumkin emas`,
            ),
            { status: 403 },
          );
        }

        stockUpdates.push({
          product,
          productId,
          nextQuantity: currentStock - requestedQty,
          requestedQty,
        });

        saleItems.push({
          productId,
          name: product.name,
          sku: product.sku,
          quantity: requestedQty,
          price: pricing.finalPrice,
          originalPrice: pricing.originalPrice,
          finalPrice: pricing.finalPrice,
          itemDiscountPercent: pricing.itemDiscountPercent,
          itemDiscountAmount: pricing.itemDiscountAmount,
          costPrice,
          returnedQty: 0,
          returnStatus: "none",
        });
      }

      const saleSubtotal = roundMoney(
        saleItems.reduce(
          (acc, item) => acc + Number(item.originalPrice || 0) * Number(item.quantity || 0),
          0,
        ),
      );
      const saleDiscountTotal = roundMoney(
        saleItems.reduce(
          (acc, item) =>
            acc +
            Math.max(0, Number(item.originalPrice || 0) - Number(item.finalPrice || 0)) *
              Number(item.quantity || 0),
          0,
        ),
      );
      const saleTotal = roundMoney(saleSubtotal - saleDiscountTotal);

      const createdSale = await tx.sale.create({
        data: {
          ...(req.body.id ? { id: String(req.body.id) } : {}),
          storeId: req.storeId,
          dateISO: req.body.dateISO || toISODate(now),
          date: req.body.date || toUzDate(now),
          time: req.body.time || toUzTime(now),
          total: saleTotal,
          saleSubtotal,
          saleDiscountTotal,
          saleTotal,
          returnedTotal: 0,
          paymentMethod: req.body.paymentMethod,
          shiftId: openShift.id,
          sellerId: req.user.id,
          sellerName: req.user.name,
          sellerRole: req.user.role,
          items: {
            create: saleItems.map((item) => ({
              ...item,
              storeId: req.storeId,
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
            storeId: req.storeId,
            isDeleted: false,
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
          req.storeId,
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
      prisma,
      req.storeId,
    );

    void notifyNewSale(toSaleDto(sale), req.storeId);

    res.status(201).json(
      toSaleDto(sale, { includeSensitive: isAdminUser(req.user) }),
    );
  }),
);

router.post(
  "/sales/close-day",
  asyncHandler(async (req, res) => {
    const dateISO = req.body.dateISO || toISODate();
    const sales = await prisma.sale.findMany({
      where: getStoreWhere(req, { status: "active", dateISO }),
      include: saleInclude,
    });

    if (!sales.length) {
      return res.status(400).json({ message: "Yakunlanadigan savdolar yo'q" });
    }

    const total = sales.reduce((acc, sale) => acc + getSaleGrossTotal(sale), 0);
    const returnedTotal = sales.reduce((acc, sale) => acc + Number(sale.returnedTotal || 0), 0);

    const report = await prisma.salesDay.upsert({
      where: { storeId_dateISO: { storeId: req.storeId, dateISO } },
      create: {
        storeId: req.storeId,
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
      where: getStoreWhere(req, { status: "active", dateISO }),
      data: { status: "closed" },
    });

    void notifyDailyReport(report, req.storeId);

    res.json({ report, dailySales: [] });
  }),
);

router.get(
  "/sales/history",
  asyncHandler(async (req, res) => {
    res.json(await buildHistory({ storeId: req.storeId, includeSensitive: isAdminUser(req.user) }));
  }),
);

router.post(
  "/returns",
  asyncHandler(async (req, res) => {
    const { saleId, productId, quantity, reason } = req.body;
    const qty = Math.floor(Number(quantity || req.body.returnedQty || 0));

    if (!String(reason || "").trim()) {
      return res.status(400).json({ message: "Vozvrat sababi kiritilishi kerak" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({
        where: { id: saleId },
        include: { items: true },
      });

      const saleItem =
        sale?.items.find((item) => item.productId === String(productId)) ||
        sale?.items.find((item) => item.id === req.body.saleItemId);

      if (!sale || sale.storeId !== req.storeId || !saleItem || saleItem.storeId !== req.storeId) {
        throw Object.assign(new Error("Savdo yoki mahsulot topilmadi"), { status: 404 });
      }

      const available = saleItem.quantity - saleItem.returnedQty;
      const returnQty = Math.min(qty, available);

      if (returnQty <= 0) {
        throw Object.assign(new Error("Qaytarish mumkin bo'lgan miqdor yo'q"), { status: 400 });
      }

      const amount = returnQty * getItemFinalPrice(saleItem);

      const returnItem = await tx.return.create({
        data: {
          storeId: req.storeId,
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

      const saleItemUpdate = await tx.saleItem.updateMany({
        where: {
          id: saleItem.id,
          storeId: req.storeId,
          returnedQty: { lte: saleItem.quantity - returnQty },
        },
        data: {
          returnedQty: { increment: returnQty },
          returnStatus: returnQty === available ? "full" : "partial",
        },
      });

      if (saleItemUpdate.count !== 1) {
        throw Object.assign(new Error("Bu mahsulot allaqachon qaytarilgan"), {
          status: 400,
        });
      }

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
      prisma,
      req.storeId,
    );

    void notifyReturn(result, req.storeId);

    res.status(201).json(result);
  }),
);

router.get(
  "/returns",
  asyncHandler(async (req, res) => {
    res.json(await prisma.return.findMany({ where: getStoreWhere(req), orderBy: { createdAt: "desc" } }));
  }),
);

router.get(
  "/suppliers",
  asyncHandler(async (req, res) => {
    const suppliers = await prisma.supplier.findMany({
      where: getStoreWhere(req),
      include: { transactions: { orderBy: { createdAt: "desc" } } },
      orderBy: { createdAt: "desc" },
    });

    res.json(suppliers.map(toSupplierDto));
  }),
);

router.post(
  "/suppliers",
  asyncHandler(async (req, res) => {
    const input = normalizeSupplierInput(req.body);

    validateSupplierInput(input);

    const supplier = await prisma.$transaction(async (tx) => {
      const supplier = await tx.supplier.create({
        data: {
          ...(req.body.id ? { id: String(req.body.id) } : {}),
          storeId: req.storeId,
          ...input,
          transactions:
            input.debt > 0
              ? {
                  create: {
                  type: "inventory",
                  storeId: req.storeId,
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
        req.storeId,
      );

      return supplier;
    });

    res.status(201).json(toSupplierDto(supplier));
  }),
);

router.put(
  "/suppliers/:id",
  asyncHandler(async (req, res) => {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ message: "Faqat admin tahrirlashi mumkin" });
    }

    const input = normalizeSupplierInput(req.body);
    validateSupplierInput(input);

    const supplier = await prisma.$transaction(async (tx) => {
      const existingSupplier = await tx.supplier.findFirst({
        where: getStoreWhere(req, { id: req.params.id }),
        select: { id: true },
      });

      if (!existingSupplier) {
        throw Object.assign(new Error("Supplier topilmadi"), { status: 404 });
      }

      const supplier = await tx.supplier.update({
        where: { id: req.params.id },
        data: input,
        include: { transactions: { orderBy: { createdAt: "desc" } } },
      });

      await addActivityLog(
        {
          type: "supplier",
          title: "TaвЂ™minotchi maвЂ™lumotlari oвЂzgartirildi",
          description: supplier.name,
        },
        req.user,
        tx,
        req.storeId,
      );

      return supplier;
    });

    res.json(toSupplierDto(supplier));
  }),
);

router.delete(
  "/suppliers/:id",
  asyncHandler(async (req, res) => {
    const existingSupplier = await prisma.supplier.findFirst({
      where: getStoreWhere(req, { id: req.params.id }),
      select: { id: true },
    });

    if (!existingSupplier) {
      throw Object.assign(new Error("Supplier topilmadi"), { status: 404 });
    }

    res.json(await prisma.supplier.delete({ where: { id: req.params.id } }));
  }),
);

router.post(
  "/suppliers/:id/transactions",
  asyncHandler(async (req, res) => {
    const supplier = await prisma.supplier.findFirst({
      where: getStoreWhere(req, { id: req.params.id }),
      select: { id: true },
    });

    if (!supplier) {
      throw Object.assign(new Error("Supplier topilmadi"), { status: 404 });
    }

    const transaction = await prisma.supplierTransaction.create({
      data: {
        storeId: req.storeId,
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
  asyncHandler(async (req, res) => {
    const amount = Number(req.body.amount || 0);

    if (amount <= 0) {
      return res.status(400).json({ message: "To'lov summasi noto'g'ri" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.supplier.findFirst({
        where: getStoreWhere(req, { id: req.params.id }),
      });

      if (!current) {
        throw Object.assign(new Error("Supplier topilmadi"), { status: 404 });
      }

      const balance = Number(current.debt || 0) - Number(current.paid || 0);

      if (amount > balance) {
        throw Object.assign(new Error("To'lov summasi qoldiq qarzdan katta"), {
          status: 400,
        });
      }

      await tx.supplier.update({
        where: { id: req.params.id },
        data: { paid: { increment: amount } },
      });

      const transaction = await tx.supplierTransaction.create({
        data: {
          storeId: req.storeId,
          supplierId: req.params.id,
          type: "payment",
          status: "To'lov",
          amount,
          date: req.body.date || toUzDate(),
          time: req.body.time || toUzTime(),
          note: req.body.note,
        },
      });

      const supplier = await tx.supplier.findUnique({
        where: { id: req.params.id },
        include: { transactions: { orderBy: { createdAt: "desc" } } },
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
      prisma,
      req.storeId,
    );

    res.status(201).json(result);
  }),
);

router.get(
  "/expenses",
  asyncHandler(async (req, res) => {
    res.json(await prisma.expense.findMany({ where: getStoreWhere(req), orderBy: { createdAt: "desc" } }));
  }),
);

router.post(
  "/expenses",
  asyncHandler(async (req, res) => {
    res.status(201).json(
      await prisma.expense.create({
        data: {
          ...req.body,
          storeId: req.storeId,
          amount: Number(req.body.amount || 0),
          date: req.body.date || toUzDate(),
        },
      }),
    );
  }),
);

router.delete(
  "/expenses/:id",
  asyncHandler(async (req, res) => {
    const existingExpense = await prisma.expense.findFirst({
      where: getStoreWhere(req, { id: req.params.id }),
      select: { id: true },
    });

    if (!existingExpense) {
      throw Object.assign(new Error("Xarajat topilmadi"), { status: 404 });
    }

    res.json(await prisma.expense.delete({ where: { id: req.params.id } }));
  }),
);

router.get(
  "/shifts/active",
  asyncHandler(async (req, res) => {
    res.json(await prisma.shift.findFirst({ where: getStoreWhere(req, { status: "open" }), orderBy: { createdAt: "desc" } }));
  }),
);

router.get(
  "/shifts",
  asyncHandler(async (req, res) => {
    res.json(await prisma.shift.findMany({ where: getStoreWhere(req), orderBy: { createdAt: "desc" } }));
  }),
);

router.post(
  "/shifts/open",
  asyncHandler(async (req, res) => {
    const now = new Date();
    const existingOpenShift = await prisma.shift.findFirst({
      where: getStoreWhere(req, { status: "open" }),
    });

    if (existingOpenShift) {
      return res.status(400).json({ message: "Ochiq shift mavjud" });
    }

    const shift = await prisma.shift.create({
      data: {
        storeId: req.storeId,
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

    await addActivityLog({ type: "shift", title: "Shift ochildi", description: shift.cashierName }, req.user, prisma, req.storeId);
    void notifyShiftOpen(shift, req.storeId);

    res.status(201).json(shift);
  }),
);

router.post(
  "/shifts/:id/close",
  asyncHandler(async (req, res) => {
    const shift = await prisma.shift.findFirst({ where: getStoreWhere(req, { id: req.params.id }) });
    if (!shift) return res.status(404).json({ message: "Shift topilmadi" });
    if (shift.status !== "open") {
      return res.status(400).json({ message: "Shift allaqachon yopilgan" });
    }

    const now = new Date();
    const sales = await prisma.sale.findMany({
      where: getShiftSalesWhere(shift, now),
    });
    const shiftTotals = summarizeSales(sales);
    const cashSales = shiftTotals.cashSales;
    const closedShift = await prisma.shift.update({
      where: { id: shift.id },
      data: {
        closedById: req.user.id,
        closedByName: req.user.name,
        closingCash: Number(req.body.closingCash || 0),
        totalSales: shiftTotals.totalSales,
        cashSales,
        cardSales: shiftTotals.cardSales,
        transferSales: shiftTotals.transferSales,
        transactions: shiftTotals.transactions,
        cashDifference: Number(req.body.closingCash || 0) - (Number(shift.openingCash || 0) + cashSales),
        closedAt: toUzTime(now),
        closedAtISO: now,
        duration: formatDuration(shift.openedAtISO, now),
        status: "closed",
      },
    });

    await addActivityLog({ type: "shift", title: "Shift yopildi", description: closedShift.cashierName }, req.user, prisma, req.storeId);
    void notifyShiftClose(closedShift, req.storeId);

    res.json(closedShift);
  }),
);

router.get(
  "/activity-logs",
  asyncHandler(async (req, res) => {
    res.json(await prisma.activityLog.findMany({ where: getStoreWhere(req), orderBy: { createdAt: "desc" }, take: 500 }));
  }),
);

router.post(
  "/activity-logs",
  asyncHandler(async (req, res) => {
    res.status(201).json(await addActivityLog(req.body, req.user, prisma, req.storeId));
  }),
);

router.get(
  "/dashboard/summary",
  asyncHandler(async (req, res) => {
    const includeHistory = req.query.includeHistory === "true";
    const todayISO = toISODate();
    const [
      inventory,
      dailySales,
      salesDays,
      expensesTotal,
      returnsTotal,
      supplierDebt,
      productCount,
      lowStockCount,
    ] = await Promise.all([
      prisma.product.findMany({
        where: getActiveProductWhere(req),
        orderBy: { createdAt: "desc" },
      }),
      prisma.sale.findMany({
        where: getStoreWhere(req, { status: "active", dateISO: todayISO }),
        include: saleInclude,
        orderBy: { createdAt: "desc" },
      }),
      includeHistory
        ? buildHistory({ storeId: req.storeId, includeSensitive: true })
        : prisma.salesDay.findMany({
            where: { storeId: req.storeId },
            orderBy: { dateISO: "desc" },
            take: 30,
          }),
      prisma.expense.aggregate({
        where: getStoreWhere(req),
        _sum: { amount: true },
      }),
      prisma.return.aggregate({
        where: getStoreWhere(req),
        _sum: { amount: true, quantity: true },
        _count: { id: true },
      }),
      prisma.supplier.aggregate({
        where: getStoreWhere(req),
        _sum: { debt: true, paid: true },
      }),
      prisma.product.count({ where: getActiveProductWhere(req) }),
      prisma.product.count({
        where: getActiveProductWhere(req, {
          quantity: { gt: 0, lte: LOW_STOCK_THRESHOLD },
        }),
      }),
    ]);

    res.json({
      inventory,
      dailySales: dailySales.map((sale) =>
        toSaleDto(sale, { includeSensitive: true }),
      ),
      salesHistory: includeHistory
        ? salesDays
        : salesDays.map((day) => ({ ...day, sales: [] })),
      expensesTotal: expensesTotal._sum.amount || 0,
      returnsTotal: returnsTotal._sum.amount || 0,
      returnsCount: returnsTotal._count.id || 0,
      returnedQuantity: returnsTotal._sum.quantity || 0,
      supplierDebt: Math.max(
        0,
        Number(supplierDebt._sum.debt || 0) - Number(supplierDebt._sum.paid || 0),
      ),
      productCount,
      lowStockCount,
    });
  }),
);

router.get(
  "/telegram/settings",
  asyncHandler(async (req, res) => {
    res.json(await getTelegramSettings(req.storeId));
  }),
);

router.put(
  "/telegram/settings",
  asyncHandler(async (req, res) => {
    res.json(await updateTelegramSettings(req.body, req.storeId));
  }),
);

router.post(
  "/telegram/test",
  asyncHandler(async (req, res) => {
    res.json(
      await sendTelegramMessage(
        "TECHPRO Telegram test\n\nTelegram bot muvaffaqiyatli ulandi.",
        undefined,
        req.storeId,
      ),
    );
  }),
);


router.post(
  "/telegram/events/:type",
  asyncHandler(async (req, res) => {
    res.json(await sendTelegramEvent(req.params.type, req.body, req.storeId));
  }),
);

export default router;
