import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const stores = [
  { id: "dokon-1", name: "dokon-1" },
  { id: "dokon-2", name: "dokon-2" },
];

const users = [
  {
    name: "Administrator",
    username: "admin",
    role: "admin",
    password: "1234",
    storeId: null,
  },
  {
    name: "Sotuvchi 1",
    username: "sotuvchi1",
    role: "cashier",
    password: "1111",
    storeId: "dokon-1",
  },
  {
    name: "Sotuvchi 2",
    username: "sotuvchi2",
    role: "cashier",
    password: "2222",
    storeId: "dokon-2",
  },
];

const products = [
  {
    id: "1",
    sku: "TP-4821",
    name: "iPhone 15 Pro Case",
    category: "Chexol",
    quantity: 50,
    costPrice: 70000,
    sellPrice: 120000,
    supplier: "Mobile Market",
    storeId: "dokon-1",
  },
  {
    id: "2",
    sku: "TP-1934",
    name: "AirPods Pro Case",
    category: "AirPods",
    quantity: 35,
    costPrice: 45000,
    sellPrice: 85000,
    supplier: "iStore",
    storeId: "dokon-1",
  },
];

for (const store of stores) {
  await prisma.store.upsert({
    where: { id: store.id },
    update: { name: store.name },
    create: store,
  });
}

for (const user of users) {
  const password = await bcrypt.hash(user.password, 10);

  await prisma.user.upsert({
    where: { username: user.username },
    update: {
      name: user.name,
      role: user.role,
      storeId: user.storeId,
      password,
    },
    create: {
      ...user,
      password,
    },
  });
}

for (const product of products) {
  await prisma.product.upsert({
    where: { id: product.id },
    update: product,
    create: product,
  });
}

await prisma.telegramSettings.upsert({
  where: { storeId: "dokon-1" },
  update: {},
  create: {
    id: "telegram-dokon-1",
    storeId: "dokon-1",
    botToken: "",
    chatId: "",
  },
});

await prisma.telegramSettings.upsert({
  where: { storeId: "dokon-2" },
  update: {},
  create: {
    id: "telegram-dokon-2",
    storeId: "dokon-2",
    botToken: "",
    chatId: "",
  },
});

await prisma.$disconnect();
