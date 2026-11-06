import { Router } from "express";
import {
  checkVisaController,
  getCountries,
  getProductsByCountry,
} from "./controller.js";

export const catalogueRouter = Router();

catalogueRouter.get("/countries", getCountries);
catalogueRouter.get("/products/:iso2", getProductsByCountry);
catalogueRouter.get("/visa-check", checkVisaController);
