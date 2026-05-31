const prisma = require("../config/prisma");

const getProducts = async () => {
  return await prisma.product.findMany({
    orderBy: {
      createdAt: "desc",
    },
  });
};

const createProduct = async (data) => {
  return await prisma.product.create({
    data: {
      name: data.name,
      sku: data.sku,
      barcode: data.barcode,
      price: Number(data.price),
      stock: Number(data.stock),
    },
  });
};

module.exports = {
  getProducts,
  createProduct,
};