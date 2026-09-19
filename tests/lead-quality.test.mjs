import { test } from "node:test";
import assert from "node:assert/strict";

import { validateLead, FieldError } from "../api/_lib/validate.mjs";
import { addressOutsideOhio, looksLikeKeyboardSmash } from "../api/_lib/lead-quality.mjs";
import { validHomeValue, validContact } from "./helpers.mjs";

function codeFor(body) {
  try {
    validateLead(body);
  } catch (err) {
    assert.ok(err instanceof FieldError);
    return err.code;
  }
  return null;
}

test("explicit out-of-state home-value addresses are rejected", () => {
  const addresses = [
    "69 W 9th St, New York, NY 10011, USA",
    "500 Woodward Ave, Detroit, MI 48226",
    "1 Monument Cir, Indianapolis, IN 46204",
    "123 Main St, Charlotte, North Carolina 28202",
    "123 Main St, Toledo, MI",
  ];
  for (const property_address of addresses) {
    assert.equal(
      codeFor({ ...validHomeValue, property_address }),
      "OUTSIDE_SERVICE_AREA",
      property_address
    );
  }
});

test("a non-Ohio ZIP is enough to reject even when the state is omitted", () => {
  assert.equal(
    codeFor({ ...validHomeValue, property_address: "69 W 9th St, New York 10011" }),
    "OUTSIDE_SERVICE_AREA"
  );
});

test("Ohio addresses remain valid in common forms", () => {
  for (const property_address of [
    "123 Louisiana Ave, Perrysburg, OH 43551",
    "100 N Summit St, Toledo, Ohio 43604",
    "123 Main St, Toledo",
  ]) {
    const out = validateLead({ ...validHomeValue, property_address });
    assert.equal(out.lead.property_address, property_address);
  }
});

test("the Ohio classifier stays conservative when state-looking locality text is ambiguous", () => {
  for (const property_address of [
    "123 Main St, Toledo",
    "123 Main St, Perrysburg",
    "123 Main St, Delaware",
    "123 Main St, Oregon",
  ]) {
    assert.equal(addressOutsideOhio(property_address), false, property_address);
  }
});

test("a full state name is actionable when a separate city component makes it explicit", () => {
  assert.equal(addressOutsideOhio("123 Main St, Charlotte, North Carolina"), true);
  assert.equal(addressOutsideOhio("123 Main St, Detroit, Michigan"), true);
});

test("observed keyboard-smash names and notes are rejected", () => {
  for (const body of [
    { ...validHomeValue, first_name: "ASDFGHJ" },
    { ...validHomeValue, last_name: "SDFGHJKL" },
    { ...validHomeValue, notes: "zasdfgn" },
    { ...validContact, message: "qwerty qwerty" },
    { ...validHomeValue, first_name: "aaaaaaaa" },
  ]) {
    assert.equal(codeFor(body), "SUSPECT_INPUT");
  }
});

test("single-key detection stays narrow enough to avoid ordinary text", () => {
  assert.equal(looksLikeKeyboardSmash("aaaaaaaa"), true);
  assert.equal(looksLikeKeyboardSmash("soooooo motivated"), false);
  assert.equal(looksLikeKeyboardSmash("A".repeat(40)), false);
});

test("ordinary uncommon-looking human input is not treated as keyboard smash", () => {
  for (const value of ["Ashford", "Santiago", "Zaslavsky", "McGhie", "Xavier"])
    assert.equal(looksLikeKeyboardSmash(value), false, value);

  const out = validateLead({
    ...validHomeValue,
    first_name: "Ashford",
    last_name: "Zaslavsky",
    notes: "Roof is older; basement is unfinished.",
  });
  assert.equal(out.lead.first_name, "Ashford");
});

test("Ohio-only rejection is specific and actionable", () => {
  assert.throws(
    () => validateLead({ ...validHomeValue, property_address: "69 W 9th St, New York, NY 10011" }),
    (err) => {
      assert.equal(err.code, "OUTSIDE_SERVICE_AREA");
      assert.match(err.message, /Ohio/i);
      return true;
    }
  );
});
