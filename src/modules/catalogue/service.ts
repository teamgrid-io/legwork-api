import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { countries, visaProducts, visaRules } from "../../db/schema.js";
import { HttpError } from "../../lib/errors.js";

export interface CountryDto {
  iso2: string;
  name: string;
  slug: string;
}

export interface ProductDto {
  id: string;
  name: string;
  route: "complete" | "guided";
  stayDays: number | null;
  processingDaysMin: number;
  processingDaysMax: number;
  passportValidityMonths: number | null;
  requiredDocuments: string[];
  governmentFeeCents: number;
  legworkFeeCents: number;
  totalPerTravellerCents: number;
  currency: string;
}

export interface VisaCheckProductDto {
  stayDays: number | null;
  processingDaysMin: number;
  processingDaysMax: number;
  passportValidityMonths: number | null;
  requiredDocuments: string[];
  totalPerTravellerCents: number;
  currency: string;
}

export interface VisaCheckDto {
  status: "unknown" | "visa_free" | "visa_required";
  message?: string;
  notes?: string | null;
  product?: VisaCheckProductDto | null;
}

export async function listCountries(): Promise<CountryDto[]> {
  return db
    .select({
      iso2: countries.iso2,
      name: countries.name,
      slug: countries.slug,
    })
    .from(countries)
    .orderBy(asc(countries.name));
}

export async function listProductsForCountry(
  iso2: string,
): Promise<ProductDto[]> {
  const [country] = await db
    .select({ id: countries.id })
    .from(countries)
    .where(eq(countries.iso2, iso2.toUpperCase()))
    .limit(1);

  if (!country) {
    throw new HttpError(404, "Country not found");
  }

  return db
    .select({
      id: visaProducts.id,
      name: visaProducts.name,
      route: visaProducts.route,
      stayDays: visaProducts.stayDays,
      processingDaysMin: visaProducts.processingDaysMin,
      processingDaysMax: visaProducts.processingDaysMax,
      passportValidityMonths: visaProducts.passportValidityMonths,
      requiredDocuments: sql<string[]>`${visaProducts.requiredDocuments}`,
      governmentFeeCents: visaProducts.governmentFeeCents,
      legworkFeeCents: visaProducts.legworkFeeCents,
      totalPerTravellerCents: sql<number>`${visaProducts.governmentFeeCents} + ${visaProducts.legworkFeeCents}`,
      currency: visaProducts.currency,
    })
    .from(visaProducts)
    .where(
      and(
        eq(visaProducts.destinationCountryId, country.id),
        eq(visaProducts.active, true),
      ),
    )
    .orderBy(asc(visaProducts.route));
}

export async function checkVisa(
  passportIso2: string,
  destinationIso2: string,
): Promise<VisaCheckDto> {
  const passportCode = passportIso2.toUpperCase();
  const destinationCode = destinationIso2.toUpperCase();

  const countryRows = await db
    .select({ id: countries.id, iso2: countries.iso2 })
    .from(countries)
    .where(inArray(countries.iso2, [passportCode, destinationCode]));

  const passportCountry = countryRows.find(
    (country) => country.iso2 === passportCode,
  );
  const destinationCountry = countryRows.find(
    (country) => country.iso2 === destinationCode,
  );

  if (!passportCountry || !destinationCountry) {
    throw new HttpError(404, "Country not found");
  }

  const [rule] = await db
    .select({
      requirement: visaRules.requirement,
      notes: visaRules.notes,
    })
    .from(visaRules)
    .where(
      and(
        eq(visaRules.destinationCountryId, destinationCountry.id),
        eq(visaRules.passportCountryId, passportCountry.id),
      ),
    )
    .limit(1);

  if (!rule) {
    return { status: "unknown", message: "Contact us to confirm" };
  }

  if (rule.requirement === "visa_free") {
    return { status: "visa_free", notes: rule.notes };
  }

  if (rule.requirement === "visa_required") {
    const [product] = await db
      .select({
        stayDays: visaProducts.stayDays,
        processingDaysMin: visaProducts.processingDaysMin,
        processingDaysMax: visaProducts.processingDaysMax,
        passportValidityMonths: visaProducts.passportValidityMonths,
        requiredDocuments: sql<string[]>`${visaProducts.requiredDocuments}`,
        totalPerTravellerCents: sql<number>`${visaProducts.governmentFeeCents} + ${visaProducts.legworkFeeCents}`,
        currency: visaProducts.currency,
      })
      .from(visaProducts)
      .where(
        and(
          eq(visaProducts.destinationCountryId, destinationCountry.id),
          eq(visaProducts.route, "complete"),
          eq(visaProducts.active, true),
        ),
      )
      .limit(1);

    return {
      status: "visa_required",
      notes: rule.notes,
      product: product ?? null,
    };
  }

  return { status: "unknown", message: "Contact us to confirm" };
}
