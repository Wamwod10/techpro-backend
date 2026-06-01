import express from "express";
import cors from "cors";
import routes from "./routes/index.js";
import { env } from "./config/env.js";

const productionFrontendUrl = "https://techpro-beryl.vercel.app";
const allowedOrigins = [
  ...new Set(
    [productionFrontendUrl, ...env.frontendUrl.split(",")]
      .map((origin) => origin.trim())
      .filter(Boolean),
  ),
];

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.json({
    message: "TECHPRO Backend API ishlayapti",
    status: "ok",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    time: new Date().toISOString(),
  });
});

app.use("/api", routes);

app.use((req, res) => {
  res.status(404).json({ message: "Route topilmadi" });
});

app.use((error, req, res, next) => {
  const prismaMessages = {
    P2002: "Bu ma'lumot bilan yozuv allaqachon mavjud",
    P2003: "Bu yozuv boshqa ma'lumotlarga bog'langan",
    P2025: "Ma'lumot topilmadi",
  };

  console.error("[API ERROR]", {
    method: req.method,
    url: req.originalUrl,
    message: error.message,
    code: error.code,
    meta: error.meta,
  });
  console.error(error);

  res.status(error.status || 500).json({
    message: prismaMessages[error.code] || error.message || "Server xatosi",
  });
});

export default app;
