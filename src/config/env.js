import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL,
  frontendUrl:
    process.env.FRONTEND_URL ||
    (process.env.NODE_ENV === "production"
      ? "https://techpro-beryl.vercel.app"
      : "http://localhost:5173"),
};
