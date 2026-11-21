import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../src/db/index.js";
import { countries, visaRules } from "../../src/db/schema.js";

const COUNTRY_CODES = ["IN", "GE", "US", "TH", "AE", "MY"] as const;
const ALLOWED_REQUIREMENTS = new Set(["visa_free", "visa_required"]);

export const suiteTests: Array<Promise<void>> = [
  test("all passport and destination pairs have one valid visa rule", async () => {
    const passport = alias(countries, "passport_country");
    const destination = alias(countries, "destination_country");

    const rows = await db
      .select({
        passportIso2: passport.iso2,
        destinationIso2: destination.iso2,
        requirement: visaRules.requirement,
        notes: visaRules.notes,
      })
      .from(visaRules)
      .innerJoin(passport, eq(visaRules.passportCountryId, passport.id))
      .innerJoin(
        destination,
        eq(visaRules.destinationCountryId, destination.id),
      )
      .where(
        and(
          inArray(passport.iso2, [...COUNTRY_CODES]),
          inArray(destination.iso2, [...COUNTRY_CODES]),
        ),
      );

    const expectedPairs = COUNTRY_CODES.flatMap((passportIso2) =>
      COUNTRY_CODES.filter((destinationIso2) => destinationIso2 !== passportIso2)
        .map((destinationIso2) => `${passportIso2}->${destinationIso2}`),
    ).sort();
    const actualPairs = rows
      .map((row) => `${row.passportIso2}->${row.destinationIso2}`)
      .sort();

    assert.equal(expectedPairs.length, 30);
    assert.equal(rows.length, 30);
    assert.deepEqual(actualPairs, expectedPairs);

    for (const row of rows) {
      assert.ok(ALLOWED_REQUIREMENTS.has(row.requirement));
    }

    const indiaThailand = rows.find(
      (row) => row.passportIso2 === "IN" && row.destinationIso2 === "TH",
    );

    assert.deepEqual(indiaThailand, {
      passportIso2: "IN",
      destinationIso2: "TH",
      requirement: "visa_required",
      notes: null,
    });
  }),
];
