import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { applicationsRouter } from "./modules/applications/routes.js";
import { catalogueRouter } from "./modules/catalogue/routes.js";
import { formsRouter } from "./modules/forms/routes.js";
import { paymentsRouter } from "./modules/payments/routes.js";
import { requestsRouter } from "./modules/requests/routes.js";
import { webhooksRouter } from "./modules/webhooks/routes.js";

export const app = express();

app.disable("x-powered-by");

app.use(cors({ origin: config.webUrl }));
app.use("/api/v1", webhooksRouter);
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/v1", catalogueRouter);
app.use("/api/v1", requestsRouter);
app.use("/api/v1", paymentsRouter);
app.use("/api/v1", formsRouter);
app.use("/api/v1", applicationsRouter);

app.use(notFoundHandler);
app.use(errorHandler);
