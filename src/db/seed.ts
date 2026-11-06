import { and, eq, inArray } from "drizzle-orm";
import { db } from "./index.js";
import { pool } from "./pool.js";
import {
  countries,
  feeVersions,
  visaProducts,
  visaRules,
} from "./schema.js";

const seedCountries = [
  { iso2: "IN", name: "India", slug: "india" },
  { iso2: "GE", name: "Georgia", slug: "georgia" },
] as const;

async function seed(): Promise<void> {
  for (const country of seedCountries) {
    const inserted = await db
      .insert(countries)
      .values(country)
      .onConflictDoNothing()
      .returning({ iso2: countries.iso2 });

    if (inserted.length > 0) {
      console.log(`Inserted country ${country.iso2} (${country.name})`);
    } else {
      console.log(`Country ${country.iso2} (${country.name}) already existed`);
    }
  }
}

async function seedVisaProduct(): Promise<void> {
  const [georgia] = await db
    .select({ id: countries.id })
    .from(countries)
    .where(eq(countries.iso2, "GE"))
    .limit(1);

  if (!georgia) {
    throw new Error("Georgia (GE) not found; run the country seed first");
  }

  const inserted = await db
    .insert(visaProducts)
    .values({
      destinationCountryId: georgia.id,
      route: "complete",
      name: "Georgia e-visa: Complete Application",
      stayDays: 90,
      processingDaysMin: 3,
      processingDaysMax: 5,
      passportValidityMonths: 6,
      requiredDocuments: ["passport_page", "photo"],
      governmentFeeCents: 2000,
      legworkFeeCents: 3500,
      currency: "USD",
      active: true,
    })
    .onConflictDoNothing()
    .returning({ id: visaProducts.id });

  if (inserted.length > 0) {
    console.log("Inserted visa product: Georgia e-visa: Complete Application");
  } else {
    console.log(
      "Visa product already existed: Georgia e-visa: Complete Application",
    );
  }
}

async function seedFeeVersion(): Promise<void> {
  const [georgiaProduct] = await db
    .select({ id: visaProducts.id })
    .from(visaProducts)
    .innerJoin(countries, eq(visaProducts.destinationCountryId, countries.id))
    .where(
      and(
        eq(countries.iso2, "GE"),
        eq(visaProducts.route, "complete"),
      ),
    )
    .limit(1);

  if (!georgiaProduct) {
    throw new Error(
      "Georgia complete visa product not found; run the visa product seed first",
    );
  }

  const inserted = await db
    .insert(feeVersions)
    .values({
      visaProductId: georgiaProduct.id,
      governmentFeeCents: 2000,
      legworkFeeCents: 3500,
      currency: "USD",
      effectiveFrom: "2026-01-01",
      createdBy: "seed",
    })
    .onConflictDoNothing()
    .returning({ id: feeVersions.id });

  if (inserted.length > 0) {
    console.log(
      "Inserted fee version for Georgia complete product effective 2026-01-01",
    );
  } else {
    console.log(
      "Fee version already existed for Georgia complete product effective 2026-01-01",
    );
  }
}

async function seedVisaRule(): Promise<void> {
  const countryRows = await db
    .select({ id: countries.id, iso2: countries.iso2 })
    .from(countries)
    .where(inArray(countries.iso2, ["GE", "IN"]));

  const georgia = countryRows.find((country) => country.iso2 === "GE");
  const india = countryRows.find((country) => country.iso2 === "IN");

  if (!georgia || !india) {
    throw new Error(
      "Georgia (GE) or India (IN) not found; run the country seed first",
    );
  }

  const inserted = await db
    .insert(visaRules)
    .values({
      destinationCountryId: georgia.id,
      passportCountryId: india.id,
      requirement: "visa_required",
      notes: "Indian passport holders need a visa for Georgia.",
    })
    .onConflictDoNothing()
    .returning({ id: visaRules.id });

  if (inserted.length > 0) {
    console.log(
      "Inserted visa rule: IN passport -> GE destination (visa_required)",
    );
  } else {
    console.log(
      "Visa rule already existed: IN passport -> GE destination (visa_required)",
    );
  }
}

try {
  await seed();
  await seedVisaProduct();
  await seedFeeVersion();
  await seedVisaRule();
} catch (error) {
  console.error(
    "Seed failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
