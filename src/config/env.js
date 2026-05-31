import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: process.env.PORT || 5000,
  nodeEnv: process.env.NODE_ENV || "development",
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET || "techpro-dev-secret-change-me",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
};
