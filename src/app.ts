import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { catalogueRouter } from "./modules/catalogue/routes.js";
import { paymentsRouter } from "./modules/payments/routes.js";
import { requestsRouter } from "./modules/requests/routes.js";

export const app = express();

app.disable("x-powered-by");

app.use(cors({ origin: config.webUrl }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use("/api", catalogueRouter);
app.use("/api", requestsRouter);
app.use("/api", paymentsRouter);

app.use(notFoundHandler);
app.use(errorHandler);
