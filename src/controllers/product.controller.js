const productService = require("../services/product.service");

const getProducts = async (req, res) => {
  try {
    const products = await productService.getProducts();

    res.json(products);
  } catch (error) {
    res.status(500).json({
      message: "Failed to get products",
    });
  }
};

const createProduct = async (req, res) => {
  try {
    const product = await productService.createProduct(req.body);

    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({
      message: "Failed to create product",
    });
  }
};

module.exports = {
  getProducts,
  createProduct,
};