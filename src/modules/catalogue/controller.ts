import type { Request, Response } from "express";
import { visaCheckQuerySchema } from "./schema.js";
import {
  checkVisa,
  listCountries,
  listProductsForCountry,
} from "./service.js";

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }

  return undefined;
}

export async function getCountries(_req: Request, res: Response): Promise<void> {
  const result = await listCountries();
  res.json(result);
}

export async function getProductsByCountry(
  req: Request,
  res: Response,
): Promise<void> {
  const iso2 = req.params.iso2;
  const countryCode = Array.isArray(iso2) ? (iso2[0] ?? "") : (iso2 ?? "");
  const result = await listProductsForCountry(countryCode);
  res.json(result);
}

export async function checkVisaController(
  req: Request,
  res: Response,
): Promise<void> {
  const query = visaCheckQuerySchema.parse({
    passport: firstQueryValue(req.query.passport),
    destination: firstQueryValue(req.query.destination),
  });

  const result = await checkVisa(query.passport, query.destination);
  res.json(result);
}
