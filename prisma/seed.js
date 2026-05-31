import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const users = [
  {
    name: "Administrator",
    username: "admin",
    role: "admin",
    password: "1234",
  },
  {
    name: "Sotuvchi 1",
    username: "sotuvchi1",
    role: "cashier",
    password: "1111",
  },
  {
    name: "Sotuvchi 2",
    username: "sotuvchi2",
    role: "cashier",
    password: "2222",
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
  },
];

for (const user of users) {
  await prisma.user.upsert({
    where: { username: user.username },
    update: {
      name: user.name,
      role: user.role,
    },
    create: {
      ...user,
      password: await bcrypt.hash(user.password, 10),
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
  where: { id: "singleton" },
  update: {},
  create: {
    id: "singleton",
    botToken: "",
    chatId: "",
  },
});

await prisma.$disconnect();
